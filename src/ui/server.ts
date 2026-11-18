/**
 * The local HTTP server: the login page, the operator's page, its script, two
 * shipment actions, the console's read-only snapshot and one explicit session
 * check. No framework, no runtime dependency beyond Node's own `http` module.
 *
 * **It binds `127.0.0.1` and nothing else.** This page can create shipments in
 * Envío Nube, so it must not be reachable from another machine: there is no
 * configurable host, no `0.0.0.0`, and no CORS header that would let a foreign
 * origin drive it. The session that makes creation possible lives in a Playwright
 * profile outside the repository; nothing in this server reads, logs or returns
 * it.
 *
 * **The app owns the front door.** Nginx used to enforce Basic Auth before
 * proxying, so the operator met the browser's native dialog. That is gone: the
 * server answers `GET /login` with its own card (`login.ts`), `POST /api/login`
 * with the password check (`auth.ts`), and every other path only with a valid
 * session cookie. The protection is data, not an `if` per route: each entry in
 * `createRoutes` declares `public: true` or `false`, and `handleRequest` applies
 * one rule to that flag. `PUBLIC_ROUTE_KEYS` is the matrix a test asserts, so a
 * new route cannot quietly become public or quietly forget the cookie.
 *
 * No session is not a 401 for a browser: a `GET` without a valid cookie is a
 * `302` to `/login`, because the operator should see the login card, not JSON. An
 * `/api/*` request without one is a `401` with a stable JSON shape, because the
 * page's own `fetch` calls need to recognise it. A tampered, expired or malformed
 * cookie is not a session: same `302`/`401`, nothing partial.
 *
 * The routes are data (`createRoutes`) so the surface can be asserted instead of
 * trusted: the only mutating shipment route is `/api/run`, which itself refuses
 * a duplicate or unresolved attempt in `actions.ts`, and the only route that
 * leaves the process is `/api/session-check`, which opens a browser because the
 * operator asked for it. Everything else is a read of `/api/console`, which
 * returns a JSON snapshot and never file bytes.
 *
 * **There is no approval route.** Creating a shipment costs nothing, so the page
 * has no hash to approve and no token to confirm (R10 as amended). The CLI keeps
 * both gates; this server simply has nothing to gate.
 *
 * **There is no artifact route.** An earlier revision served every regular file
 * under `artifacts/` at `GET /artifacts/...` with no authentication of its own.
 * Those files are Playwright traces and screenshots: recipient personal data and
 * panel-session material. The route was removed instead of authenticated, because
 * the operator has SSH and retrieves the files from the mounted volume; a web
 * server that can create shipments must not also hand out PII. Nothing in this
 * file reads a file's bytes to answer a request, and no route is a prefix.
 *
 * **Two routes open a browser, and they share one lock.** `/api/run` (both
 * modes) and `/api/session-check` each used to spawn a Chromium on demand. The
 * documented container has memory for one, so they now take `browserLock`
 * (`lock.ts`) for the whole request: a second request gets a `409` carrying
 * `LOCK_BUSY_MESSAGE` and runs nothing at all, and the lock is released in a
 * `finally` whatever the run does.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { messageOf } from '../executor/errors';
import { analyzeMessage, runAttempt, type ActionDeps } from './actions';
import {
  LOGIN_API_PATH,
  LOGIN_FAILED_MESSAGE,
  LOGIN_PATH,
  LOGOUT_API_PATH,
  SESSION_COOKIE_NAME,
  createAuthRuntime,
  createSessionToken,
  expiredSessionCookie,
  rateLimitMessage,
  readCookie,
  sessionCookie,
  verifyPassword,
  verifySessionToken,
  type AuthConfig,
  type AuthRuntime,
} from './auth';
import { CLIENT_JS } from './client';
import { performSessionCheck, readConsole, resolveConsoleDeps, type ConsoleDeps } from './console';
import { LOGIN_HTML } from './login';
import { LOCK_BUSY_MESSAGE, withBrowserLock } from './lock';
import { ARTIFACT_RETRIEVAL_INSTRUCTION, PAGE_HTML } from './page';

export { ARTIFACT_RETRIEVAL_INSTRUCTION, CLIENT_JS, LOCK_BUSY_MESSAGE, LOGIN_HTML, PAGE_HTML };

/** Loopback only. Not configurable, by design. */
export const HOST = '127.0.0.1';

/** Where `npm run ui` listens unless `--port` says otherwise. */
export const DEFAULT_PORT = 4319;

/**
 * Upper bound on a posted body, measured on the decoded text. A pasted WhatsApp
 * message is a few kilobytes; anything wildly bigger is refused instead of
 * buffered.
 */
export const MAX_BODY_LENGTH = 1_000_000;

/**
 * The whole exception list, as data. Everything not named here requires a valid,
 * unexpired, correctly signed session cookie. A test asserts that the route table's
 * `public` flags are exactly this set, so the matrix cannot drift from the code.
 */
export const PUBLIC_ROUTE_KEYS: readonly string[] = [
  `GET ${LOGIN_PATH}`,
  'GET /app.js',
  `POST ${LOGIN_API_PATH}`,
];

/** The one sentence an `/api/*` request gets without a session. */
export const UNAUTHORIZED_MESSAGE = 'Esta ruta requiere una sesión válida: entrá por /login.';

/** The stable JSON shape of an unauthenticated API answer. */
export interface UnauthorizedBody {
  status: 'unauthorized';
  reason: string;
}

export interface UiResponse {
  status: number;
  contentType: string;
  /** Text, always: no route returns file bytes. */
  body: string;
  /** Extra headers. Only `set-cookie` and `location` are ever written. */
  headers?: Record<string, string>;
}

/**
 * What one request carries into a route handler. The auth runtime (config, failure
 * budget and clock), the raw `cookie` header, the source address the rate limit
 * counts and the request's own clock.
 */
export interface RouteContext {
  auth: AuthRuntime;
  cookieHeader: string | undefined;
  /** The peer address, as `req.socket.remoteAddress` reports it. */
  address: string;
  /** Milliseconds since the epoch, so a test can age a session. */
  now: number;
}

export interface Route {
  method: 'GET' | 'POST';
  path: string;
  /** One line for the UI map, and for the assertion that no route does more. */
  purpose: string;
  /** `true` for the login page, its script and the login POST: no cookie needed. */
  public: boolean;
  handle(body: string, context: RouteContext): Promise<UiResponse>;
}

/**
 * True when one request path belongs to a route. Every route is an exact path:
 * there is no prefix route, so a request cannot name a file below a route.
 */
function routeMatches(route: Route, path: string): boolean {
  return route.path === path;
}

function json(status: number, value: unknown, headers: Record<string, string> = {}): UiResponse {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(value), headers };
}

/** A `302` for a browser: show the login card instead of JSON. */
function seeOther(location: string, headers: Record<string, string> = {}): UiResponse {
  return { status: 302, contentType: 'text/html; charset=utf-8', body: '', headers: { location, ...headers } };
}

/**
 * A `POST` answered with a redirect to `GET /login`: `303` is the status that says
 * "the next request is a GET", so a refresh cannot re-post the logout.
 */
function redirectToLogin(headers: Record<string, string> = {}): UiResponse {
  return { status: 303, contentType: 'text/html; charset=utf-8', body: '', headers: { location: LOGIN_PATH, ...headers } };
}

function unauthorized(path: string): UiResponse {
  if (path.startsWith('/api/')) {
    const body: UnauthorizedBody = { status: 'unauthorized', reason: UNAUTHORIZED_MESSAGE };
    return json(401, body);
  }
  // A browser asked for a page: send it to the card instead of showing JSON.
  return seeOther(LOGIN_PATH);
}

/**
 * A request that arrived while another one holds the browser lock. `409`, the
 * one message from `lock.ts`, and nothing was read or written on its behalf.
 */
function busy(heldBy: string | null): UiResponse {
  return json(409, { status: 'busy', heldBy, reason: LOCK_BUSY_MESSAGE });
}

function html(body: string): UiResponse {
  return { status: 200, contentType: 'text/html; charset=utf-8', body };
}

function javascript(body: string): UiResponse {
  return { status: 200, contentType: 'text/javascript; charset=utf-8', body };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ParsedBody {
  ok: boolean;
  value: Record<string, unknown>;
  reason: string;
}

function parseBody(body: string): ParsedBody {
  if (body.trim() === '') return { ok: true, value: {}, reason: '' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return { ok: false, value: {}, reason: `the body is not JSON: ${messageOf(error)}` };
  }
  if (!isRecord(parsed)) return { ok: false, value: {}, reason: 'the body must be a JSON object' };
  return { ok: true, value: parsed, reason: '' };
}

function textField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : '';
}

function formField(source: Record<string, unknown>): Record<string, unknown> {
  const form = source['form'];
  return isRecord(form) ? form : {};
}

/** Whether this request carries a session that verifies and has not expired. */
export function hasValidSession(context: RouteContext): boolean {
  const token = readCookie(context.cookieHeader, SESSION_COOKIE_NAME);
  return verifySessionToken(token, context.auth.config.sessionSecret, context.now).ok;
}

/**
 * `POST /api/login`, the one place a password is compared.
 *
 * The order is: budget first (so a locked address spends no CPU on scrypt), then
 * the comparison, then either a signed cookie or one generic sentence. A body
 * that is not a JSON object counts as a failure too: the route never explains the
 * difference, and a malformed attempt is still an attempt.
 */
async function login(body: string, context: RouteContext): Promise<UiResponse> {
  const decision = context.auth.limiter.check(context.address);
  if (!decision.allowed) {
    return json(429, { status: 'rate-limited', reason: rateLimitMessage(decision.retryAfterSeconds) }, {
      'retry-after': String(decision.retryAfterSeconds),
    });
  }

  const parsed = parseBody(body);
  const password = parsed.ok ? textField(parsed.value, 'password') : '';
  const accepted = parsed.ok && password !== '' && (await verifyPassword(password, context.auth.config.passwordHash));

  if (!accepted) {
    context.auth.limiter.recordFailure(context.address);
    return json(401, { status: 'unauthorized', reason: LOGIN_FAILED_MESSAGE });
  }

  context.auth.limiter.reset(context.address);
  const token = createSessionToken(context.auth.config.sessionSecret, context.now);
  return json(
    200,
    { status: 'ok', expiresAt: token.expiry },
    { 'set-cookie': sessionCookie(token) },
  );
}

/**
 * The whole surface of the page. Nine routes: the login card, the document, its
 * script, the login and logout actions, the two shipment actions, the console
 * snapshot and the one explicit session check. Nothing else exists to navigate to,
 * and nothing below exists to fetch.
 */
export function createRoutes(deps: ActionDeps): Route[] {
  const consoleDeps: ConsoleDeps = resolveConsoleDeps({ recordDir: deps.recordDir, ...(deps.console ?? {}) });

  return [
    {
      method: 'GET',
      path: LOGIN_PATH,
      purpose: 'la tarjeta de entrada: una contraseña, un botón y el error en la propia página',
      public: true,
      handle: async () => html(LOGIN_HTML),
    },
    {
      method: 'GET',
      path: '/',
      purpose: 'la unica pagina: pegar el mensaje, revisar los datos y crear el envio',
      public: false,
      handle: async () => html(PAGE_HTML),
    },
    {
      method: 'GET',
      path: '/app.js',
      purpose: 'el script de la pagina: unas pocas llamadas fetch, sin framework',
      public: true,
      handle: async () => javascript(CLIENT_JS),
    },
    {
      method: 'POST',
      path: LOGIN_API_PATH,
      purpose: 'compara la contraseña con MDL_PASSWORD_HASH y, si coincide, firma la cookie de sesión',
      public: true,
      handle: async (body, context) => await login(body, context),
    },
    {
      method: 'POST',
      path: LOGOUT_API_PATH,
      purpose: 'cierra la sesión: borra la cookie y vuelve a la tarjeta de entrada',
      public: false,
      handle: async () => redirectToLogin({ 'set-cookie': expiredSessionCookie() }),
    },
    {
      method: 'POST',
      path: '/api/analyze',
      purpose: 'parsea el mensaje pegado y devuelve el formulario editable, o el rechazo con sus motivos',
      public: false,
      handle: async (body) => {
        const parsed = parseBody(body);
        if (!parsed.ok) return json(400, { status: 'bad-request', reason: parsed.reason });
        return json(200, analyzeMessage(textField(parsed.value, 'message')));
      },
    },
    {
      method: 'POST',
      path: '/api/run',
      purpose: 'recorre el panel en seco, o crea el envio: sin aprobacion ni token, solo el mensaje y los datos',
      public: false,
      handle: async (body) => {
        const parsed = parseBody(body);
        if (!parsed.ok) return json(400, { status: 'bad-request', reason: parsed.reason });

        const mode = textField(parsed.value, 'mode');
        if (mode !== 'create' && mode !== 'dry-run') {
          return json(400, {
            status: 'bad-request',
            reason: 'mode debe ser "dry-run" o "create"',
          });
        }

        // Both modes drive the panel, so both take the one browser lock. The
        // duplicate check is read inside it too: it must not race a run that is
        // about to write its own record.
        const guarded = await withBrowserLock('run', async () =>
          runAttempt(
            {
              message: textField(parsed.value, 'message'),
              form: formField(parsed.value),
              mode,
            },
            deps,
          ),
        );
        if (!guarded.ok) return busy(guarded.holder);
        return json(200, guarded.value);
      },
    },
    {
      method: 'GET',
      path: '/api/console',
      purpose:
        'estado de solo lectura para el rail: sesion, runs, artefactos, errores, runtime y la linea de salud derivada',
      public: false,
      handle: async () => json(200, await readConsole(consoleDeps)),
    },
    {
      method: 'POST',
      path: '/api/session-check',
      purpose:
        'corre session-check solo cuando el operador lo pide: abre un navegador y guarda el resultado en el historial',
      public: false,
      handle: async () => {
        // The same lock as `/api/run`: one Chromium at a time in this process,
        // and the timeout escalation runs inside it, so a wedged browser cannot
        // be left behind holding the lock.
        const guarded = await withBrowserLock('session-check', async () => performSessionCheck(consoleDeps));
        if (!guarded.ok) return busy(guarded.holder);

        const outcome = guarded.value;
        return json(200, { ...outcome.snapshot, check: outcome.check, problems: outcome.problems });
      },
    },
  ];
}

/**
 * Dispatches one request. Authentication comes first, before routing, so an
 * unknown path is not a way to learn the surface: without a session it is the same
 * `302` (browser) or `401` (API) as any other protected path. Once authenticated,
 * an unknown path is a 404 and a known exact path with the wrong method is a 405.
 * There is no route that resolves a file name.
 */
export async function handleRequest(
  method: string,
  path: string,
  body: string,
  deps: ActionDeps,
  context: RouteContext,
): Promise<UiResponse> {
  const routes = createRoutes(deps);
  const route = routes.find((candidate) => candidate.method === method && routeMatches(candidate, path));

  if (route === undefined || !route.public) {
    if (!hasValidSession(context)) return unauthorized(path);
  }
  if (route !== undefined) return await route.handle(body, context);

  if (routes.some((candidate) => routeMatches(candidate, path))) {
    return json(405, { status: 'method-not-allowed', method, path });
  }
  return json(404, { status: 'not-found', path });
}

function pathnameOf(url: string): string {
  try {
    return new URL(url, `http://${HOST}`).pathname;
  } catch {
    return url;
  }
}

/** One header, whether Node gave us a string or a repeated value. */
function headerValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join('; ') : value;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let body = '';
    let tooLarge = false;

    request.on('data', (chunk) => {
      if (tooLarge) return;
      body += chunk.toString('utf8');
      if (body.length > MAX_BODY_LENGTH) {
        tooLarge = true;
        reject(new Error(`the body is longer than ${MAX_BODY_LENGTH} characters`));
      }
    });
    request.on('end', () => {
      if (!tooLarge) resolve(body);
    });
    request.on('error', (error) => {
      reject(error);
    });
  });
}

function send(response: ServerResponse, result: UiResponse): void {
  response.statusCode = result.status;
  response.setHeader('content-type', result.contentType);
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  // Deliberately no access-control-* header: no other origin may drive this page.
  for (const [name, value] of Object.entries(result.headers ?? {})) response.setHeader(name, value);
  response.end(result.body);
}

async function respond(
  request: IncomingMessage,
  response: ServerResponse,
  deps: ActionDeps,
  auth: AuthRuntime,
): Promise<void> {
  const method = (request.method ?? 'GET').toUpperCase();
  const path = pathnameOf(request.url ?? '/');

  const context: RouteContext = {
    auth,
    cookieHeader: headerValue(request.headers['cookie']),
    address: request.socket?.remoteAddress ?? 'unknown',
    now: auth.now(),
  };

  let body = '';
  if (method === 'POST') {
    try {
      body = await readBody(request);
    } catch (error) {
      send(
        response,
        json(413, {
          status: 'bad-request',
          reason: `the body was refused: ${messageOf(error)}`,
        }),
      );
      return;
    }
  }

  try {
    send(response, await handleRequest(method, path, body, deps, context));
  } catch (error) {
    send(response, json(500, { status: 'error', reason: messageOf(error) }));
  }
}

export interface UiServerOptions {
  deps: ActionDeps;
  /**
   * The login configuration from `readAuthConfig`. Required, and there is no
   * default: a server with no configured password is not a server this process
   * starts.
   */
  auth: AuthConfig;
  /** `0` picks a free port; the default is `DEFAULT_PORT`. The host is never an option. */
  port?: number;
  /** The clock used for cookie expiry and the login budget. A test seam. */
  now?: () => number;
  /** The login budget. A test seam; the defaults are five failures per 15 minutes. */
  loginRateLimit?: { limit?: number; windowMs?: number };
}

export interface StartedUiServer {
  server: Server;
  /** Always `127.0.0.1`. */
  host: string;
  port: number;
  url: string;
  /** The configured runtime: the config, the failure budget and the clock. */
  auth: AuthRuntime;
  close(): Promise<void>;
}

/** Starts the page. There is no host parameter: loopback is the whole point. */
export async function startUiServer(options: UiServerOptions): Promise<StartedUiServer> {
  const requested = options.port ?? DEFAULT_PORT;
  const auth = createAuthRuntime(options.auth, {
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.loginRateLimit?.limit === undefined ? {} : { limit: options.loginRateLimit.limit }),
    ...(options.loginRateLimit?.windowMs === undefined ? {} : { windowMs: options.loginRateLimit.windowMs }),
  });

  const server = createServer((request, response) => {
    void respond(request, response, options.deps, auth);
  });

  await new Promise<void>((resolve) => {
    server.listen(requested, HOST, resolve);
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : requested;

  return {
    server,
    host: HOST,
    port,
    url: `http://${HOST}:${port}`,
    auth,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined || error === null ? resolve() : reject(error)));
      }),
  };
}

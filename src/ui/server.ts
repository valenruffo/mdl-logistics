/**
 * The local HTTP server: the console page, its script, three shipment actions and
 * the console's read-only surface (a JSON snapshot, the artifact downloads, and
 * one explicit session check). No framework, no runtime dependency beyond Node's
 * own `http` and `fs` modules.
 *
 * **It binds `127.0.0.1` and nothing else.** This page can create shipments in
 * Envío Nube, so it must not be reachable from another machine: there is no
 * configurable host, no `0.0.0.0`, and no CORS header that would let a foreign
 * origin drive it. The session that makes creation possible lives in a Playwright
 * profile outside the repository; nothing in this server reads, logs or returns
 * it.
 *
 * The routes are data (`createRoutes`) so the surface can be asserted instead of
 * trusted: the only mutating shipment route is `/api/run`, which itself refuses
 * unless both gates in `actions.ts` pass, and the only route that leaves the
 * process is `/api/session-check`, which opens a browser because the operator
 * asked for it. Everything else is a read: `/api/console` and the files under
 * `artifacts/`, both of which only ever return bytes from this machine.
 */
import { readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { messageOf } from '../executor/errors';
import { analyzeMessage, approveForm, runAttempt, type ActionDeps } from './actions';
import { CLIENT_JS } from './client';
import { performSessionCheck, readConsole, resolveConsoleDeps, type ConsoleDeps } from './console';
import { PAGE_HTML } from './page';
import {
  ARTIFACT_ROUTE_PREFIX,
  MAX_SERVED_ARTIFACT_BYTES,
  baseNameOf,
  contentTypeFor,
  resolveArtifactTarget,
} from './paths';

export { CLIENT_JS, PAGE_HTML };

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

export interface UiResponse {
  status: number;
  contentType: string;
  /** Bytes for an artifact download, text for everything else. */
  body: string | Uint8Array;
}

export interface Route {
  method: 'GET' | 'POST';
  path: string;
  /** One line for the UI map, and for the assertion that no route does more. */
  purpose: string;
  /**
   * True when `path` is a prefix rather than an exact path. Exactly one route uses
   * it: the artifact tree, whose file names cannot be enumerated in a table.
   */
  prefix?: true;
  handle(body: string, path: string): Promise<UiResponse>;
}

/** True when one request path belongs to a route (exact or prefix). */
function routeMatches(route: Route, path: string): boolean {
  return route.prefix === true ? path.startsWith(route.path) : route.path === path;
}

function json(status: number, value: unknown): UiResponse {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(value) };
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

/**
 * The whole surface of the page. Eight routes: the document, its script, the
 * three shipment actions, the console snapshot, the one explicit session check
 * and the artifact downloads. Nothing else exists to navigate to.
 */
export function createRoutes(deps: ActionDeps): Route[] {
  const consoleDeps: ConsoleDeps = resolveConsoleDeps({ recordDir: deps.recordDir, ...(deps.console ?? {}) });

  return [
    {
      method: 'GET',
      path: '/',
      purpose: 'la unica pagina: pegar el mensaje, revisar, aprobar, ejecutar',
      handle: async () => html(PAGE_HTML),
    },
    {
      method: 'GET',
      path: '/app.js',
      purpose: 'el script de la pagina: tres llamadas fetch, sin framework',
      handle: async () => javascript(CLIENT_JS),
    },
    {
      method: 'POST',
      path: '/api/analyze',
      purpose: 'parsea el mensaje pegado y devuelve el formulario editable, o el rechazo con sus motivos',
      handle: async (body) => {
        const parsed = parseBody(body);
        if (!parsed.ok) return json(400, { status: 'bad-request', reason: parsed.reason });
        return json(200, analyzeMessage(textField(parsed.value, 'message')));
      },
    },
    {
      method: 'POST',
      path: '/api/approve',
      purpose: 'recalcula en el servidor el hash del payload editado y lo devuelve para mostrar',
      handle: async (body) => {
        const parsed = parseBody(body);
        if (!parsed.ok) return json(400, { status: 'bad-request', reason: parsed.reason });
        const result = await approveForm(
          { message: textField(parsed.value, 'message'), form: formField(parsed.value) },
          deps,
        );
        return json(200, result);
      },
    },
    {
      method: 'POST',
      path: '/api/run',
      purpose: 'recorre el panel en seco, o crea el envio solo con la aprobacion y la confirmacion escritas',
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

        const approvedHash = parsed.value['approvedHash'];
        const token = parsed.value['token'];

        const result = await runAttempt(
          {
            message: textField(parsed.value, 'message'),
            form: formField(parsed.value),
            mode,
            approvedHash: typeof approvedHash === 'string' ? approvedHash : null,
            token: typeof token === 'string' ? token : null,
          },
          deps,
        );
        return json(200, result);
      },
    },
    {
      method: 'GET',
      path: '/api/console',
      purpose:
        'estado de solo lectura: runtime, sesion, runs, artefactos, errores y la linea de salud derivada',
      handle: async () => json(200, await readConsole(consoleDeps)),
    },
    {
      method: 'POST',
      path: '/api/session-check',
      purpose:
        'corre session-check solo cuando el operador lo pide: abre un navegador y guarda el resultado en el historial',
      handle: async () => {
        const outcome = await performSessionCheck(consoleDeps);
        return json(200, { ...outcome.snapshot, check: outcome.check, problems: outcome.problems });
      },
    },
    {
      method: 'GET',
      path: ARTIFACT_ROUTE_PREFIX,
      prefix: true,
      purpose:
        'descarga de solo lectura de un archivo bajo artifacts/, con el recorrido de rutas rechazado',
      handle: async (_body, path) => serveArtifact(consoleDeps.artifactsDir, path),
    },
  ];
}

/**
 * Serves one artifact. The path arithmetic and the traversal refusal live in
 * `paths.ts`; this only turns the answer into a response, and refuses to buffer a
 * file past `MAX_SERVED_ARTIFACT_BYTES`.
 */
function serveArtifact(artifactsDir: string, path: string): UiResponse {
  const target = resolveArtifactTarget(artifactsDir, path);
  if (!target.ok) return json(target.status, { status: 'refused', reason: target.reason });

  let size: number;
  try {
    size = statSync(target.file).size;
  } catch (error) {
    return json(404, { status: 'not-found', reason: `no se pudo leer el archivo: ${messageOf(error)}` });
  }

  if (size > MAX_SERVED_ARTIFACT_BYTES) {
    return json(413, {
      status: 'refused',
      reason: `el archivo pesa ${size} bytes y el limite es ${MAX_SERVED_ARTIFACT_BYTES}`,
    });
  }

  let bytes: Uint8Array;
  try {
    bytes = readFileSync(target.file);
  } catch (error) {
    return json(500, { status: 'error', reason: `no se pudo leer el archivo: ${messageOf(error)}` });
  }

  return { status: 200, contentType: contentTypeFor(baseNameOf(target.file)), body: bytes };
}

/** Dispatches one request. An unknown path is a 404; a known path with the wrong method is a 405. */
export async function handleRequest(
  method: string,
  path: string,
  body: string,
  deps: ActionDeps,
): Promise<UiResponse> {
  const routes = createRoutes(deps);
  const route = routes.find((candidate) => candidate.method === method && routeMatches(candidate, path));
  if (route !== undefined) return await route.handle(body, path);

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
  // Deliberately no access-control-* header: no other origin may drive this page.
  response.end(result.body);
}

async function respond(
  request: IncomingMessage,
  response: ServerResponse,
  deps: ActionDeps,
): Promise<void> {
  const method = (request.method ?? 'GET').toUpperCase();
  const path = pathnameOf(request.url ?? '/');

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
    send(response, await handleRequest(method, path, body, deps));
  } catch (error) {
    send(response, json(500, { status: 'error', reason: messageOf(error) }));
  }
}

export interface UiServerOptions {
  deps: ActionDeps;
  /** `0` picks a free port; the default is `DEFAULT_PORT`. The host is never an option. */
  port?: number;
}

export interface StartedUiServer {
  server: Server;
  /** Always `127.0.0.1`. */
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

/** Starts the page. There is no host parameter: loopback is the whole point. */
export async function startUiServer(options: UiServerOptions): Promise<StartedUiServer> {
  const requested = options.port ?? DEFAULT_PORT;
  const server = createServer((request, response) => {
    void respond(request, response, options.deps);
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
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined || error === null ? resolve() : reject(error)));
      }),
  };
}

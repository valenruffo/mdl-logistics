import { statSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { readEnv, readEnvBool, readEnvInt } from './env';
import { ExecutorError, messageOf } from './errors';
import {
  adminAppDashboardUrl,
  ENVIO_NUBE_FRAME_HOST,
  storeAdminAgencyUrl,
  storeAdminUrl,
} from './panel';
import { poll } from './wait';

/**
 * The browser session.
 *
 * Login is never automated: the store sends a recovery code (2FA), so a human
 * logs in once on a machine with a screen and the resulting session is
 * transferred (R15). This module opens that session and refuses loudly when it is
 * unusable — it never attempts a login and never retries.
 *
 * Two modes, chosen by the environment and nothing else:
 *
 * - **persistent profile** (default, unchanged): a human-prepared, already
 *   logged-in Chromium profile that lives outside the repository. This is how the
 *   tool is used locally, next to the operator.
 * - **transferred storage state** (`MDL_STORAGE_STATE`): a Playwright
 *   `storageState` JSON file seeds a **non-persistent** context. This is the
 *   server mode: there is no display and no profile on a VPS, and the profile
 *   must not be copied around as a directory.
 *
 * `MDL_HEADLESS` (`true`/`false`, default `false`) applies to both modes. Both
 * switches are resolved by `resolveSessionConfig()` through the env layer, so no
 * other module reads `process.env` and an invalid value is refused instead of
 * guessed.
 */

/** Default profile location. Overridable with `MDL_PROFILE`. */
export const DEFAULT_PROFILE_DIR = 'C:\\Users\\valen\\.mdl\\browser-profile';

/** Switch that launches the browser without a window. */
export const HEADLESS_VARIABLE = 'MDL_HEADLESS';

/** Switch that seeds a non-persistent context from a transferred storageState file. */
export const STORAGE_STATE_VARIABLE = 'MDL_STORAGE_STATE';

export class SessionError extends ExecutorError {
  constructor(message: string, details: readonly string[] = []) {
    super(message, details);
    this.name = 'SessionError';
  }
}

/** Where the session comes from. */
export type SessionMode = 'persistent-profile' | 'storage-state';

/** The resolved session switches. Data only: resolving them launches nothing. */
export interface SessionConfig {
  mode: SessionMode;
  headless: boolean;
  /** Persistent profile directory, or `null` in storage-state mode. */
  profileDir: string | null;
  /** Transferred storageState file, or `null` in persistent-profile mode. */
  storageStatePath: string | null;
}

export interface Session {
  mode: SessionMode;
  context: BrowserContext;
  page: Page;
  profileDir: string | null;
  storageStatePath: string | null;
  headless: boolean;
  close(): Promise<void>;
}

export function resolveProfileDir(): string {
  return readEnv('MDL_PROFILE') ?? DEFAULT_PROFILE_DIR;
}

/** One line naming the session source, safe to print and to put in failure details. */
export function describeSessionConfig(config: SessionConfig): string {
  const headless = `headless: ${String(config.headless)}`;
  if (config.mode === 'storage-state') {
    return `storage state ${JSON.stringify(config.storageStatePath)} (${headless})`;
  }
  return `persistent profile ${JSON.stringify(config.profileDir)} (${headless})`;
}

/**
 * Resolves the two switches.
 *
 * - `MDL_HEADLESS` absent/empty → `false`; `true`/`false` accepted; anything else
 *   (including the old truthy `1`) is an `EnvError`, because a misread switch on
 *   a server means either a missing display or a silently wrong mode.
 * - `MDL_STORAGE_STATE` absent/empty → today's persistent profile, untouched.
 *   Present → must be an existing readable file; the mode becomes
 *   `storage-state` and the profile is not used at all.
 */
export function resolveSessionConfig(): SessionConfig {
  const headless = readEnvBool(HEADLESS_VARIABLE, false);
  const storageStatePath = readEnv(STORAGE_STATE_VARIABLE);

  if (storageStatePath === undefined) {
    return {
      mode: 'persistent-profile',
      headless,
      profileDir: resolveProfileDir(),
      storageStatePath: null,
    };
  }

  assertStorageStateFile(storageStatePath);
  return { mode: 'storage-state', headless, profileDir: null, storageStatePath };
}

/**
 * A missing or non-file storage state is refused before Playwright is launched:
 * a blank browser would otherwise look like an expired session and send the
 * operator chasing the wrong problem.
 */
function assertStorageStateFile(path: string): void {
  let isFile = false;
  try {
    isFile = statSync(path).isFile();
  } catch (error) {
    throw new SessionError(`the transferred session file cannot be read: "${path}"`, [
      `variable: ${STORAGE_STATE_VARIABLE}`,
      `error: ${messageOf(error)}`,
      'the file is the Playwright storageState produced by scripts/session-export.mjs on a machine with a screen',
      'it holds the logged-in store session: copy it to the server, mount it read-only, never commit it (R15)',
    ]);
  }

  if (!isFile) {
    throw new SessionError(`the transferred session path is not a file: "${path}"`, [
      `variable: ${STORAGE_STATE_VARIABLE}`,
      'expected the storageState JSON file itself, not a directory',
      'produce it with scripts/session-export.mjs and copy that exact file',
    ]);
  }
}

/** `/auth/...`, `/login`, `/recovery-code` — the paths that mean "not logged in". */
function looksLikeLoginUrl(url: string): boolean {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Not a parseable URL (about:blank, chrome://): keep the raw value.
  }
  return /\/auth(\/|$)/.test(pathname) || /\/(login|recovery-code|signin|sign-in)(\/|$)/.test(pathname);
}

/** The session shapes that matter to the operator and to the ops check. */
export type SessionState = 'ready' | 'login' | 'login-form' | 'no-admin-shell';

/**
 * One non-polling probe of the session. `login-form` also covers the 2FA
 * recovery step, which is a password/code form on the store's auth host.
 */
export async function readSessionState(page: Page): Promise<SessionState> {
  if (looksLikeLoginUrl(page.url())) return 'login';
  if ((await page.locator('input[type="password"]').count().catch(() => 0)) > 0) return 'login-form';

  const shellLink = page.getByRole('link', { name: /Envío Nube/i }).first();
  if ((await shellLink.count()) === 0) return 'no-admin-shell';
  return (await shellLink.isVisible()) ? 'ready' : 'no-admin-shell';
}

/**
 * Launches the browser for the resolved mode and returns the session without
 * navigating anywhere. Used by `openSession()` and by the two session scripts:
 * `scripts/session-export.mjs` needs a headed window to log in, and
 * `scripts/session-check.mjs` opens the app entry point itself.
 */
export async function openBrowserSession(config: SessionConfig): Promise<Session> {
  return config.mode === 'storage-state'
    ? openStorageStateSession(config)
    : openPersistentProfileSession(config);
}

async function openPersistentProfileSession(config: SessionConfig): Promise<Session> {
  const profileDir = config.profileDir;
  if (profileDir === null) {
    throw new SessionError('the persistent-profile session mode has no profile directory', [
      'this is a configuration bug, not an operator problem',
    ]);
  }

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: config.headless,
      viewport: { width: 1440, height: 900 },
    });
  } catch (error) {
    throw new SessionError(`could not open the prepared browser profile at "${profileDir}"`, [
      `headless: ${String(config.headless)}`,
      `error: ${messageOf(error)}`,
      'the profile holds the logged-in store session and must not be recreated',
      'if another Chromium process is using it (for example scripts/observe.mjs), close that process first and run again',
    ]);
  }

  const page = context.pages()[0] ?? (await context.newPage());

  return {
    mode: 'persistent-profile',
    context,
    page,
    profileDir,
    storageStatePath: null,
    headless: config.headless,
    close: async (): Promise<void> => {
      await context.close();
    },
  };
}

async function openStorageStateSession(config: SessionConfig): Promise<Session> {
  const storageStatePath = config.storageStatePath;
  if (storageStatePath === null) {
    throw new SessionError('the storage-state session mode has no file', [
      'this is a configuration bug, not an operator problem',
    ]);
  }

  const { browser, context } = await launchFromStorageState(config, storageStatePath);
  const page = context.pages()[0] ?? (await context.newPage());

  return {
    mode: 'storage-state',
    context,
    page,
    profileDir: null,
    storageStatePath,
    headless: config.headless,
    close: async (): Promise<void> => {
      await context.close().catch(() => {
        // Closing context and browser is best-effort; the session file is untouched either way.
      });
      await browser.close().catch(() => {});
    },
  };
}

async function launchFromStorageState(
  config: SessionConfig,
  storageStatePath: string,
): Promise<{ browser: Browser; context: BrowserContext }> {
  let browser: Browser | null = null;
  try {
    // Non-persistent on purpose: the server must not keep a mutable profile, and
    // the transferred file stays the single source of the session.
    browser = await chromium.launch({ headless: config.headless });
    const context = await browser.newContext({
      storageState: storageStatePath,
      viewport: { width: 1440, height: 900 },
    });
    return { browser, context };
  } catch (error) {
    if (browser !== null) await browser.close().catch(() => {});
    throw new SessionError(`could not open the browser seeded from "${storageStatePath}"`, [
      `variable: ${STORAGE_STATE_VARIABLE}`,
      `headless: ${String(config.headless)}`,
      `error: ${messageOf(error)}`,
      'the file must be a Playwright storageState JSON produced by scripts/session-export.mjs',
      'on a server with no display, MDL_HEADLESS=true is required; on a desktop it may stay unset',
    ]);
  }
}

/**
 * Opens the session for the resolved mode, navigates to the manual-shipment entry
 * point and asserts the admin shell is usable. A profile that Chromium cannot
 * open, an unusable session file or a login page is reported as an actionable
 * session problem, not as a mystery timeout.
 */
export async function openSession(): Promise<Session> {
  const timeoutMs = readEnvInt('MDL_WAIT_TIMEOUT_MS', 60_000);
  const config = resolveSessionConfig();
  const session = await openBrowserSession(config);

  try {
    await ensureAdminPage(session.page, timeoutMs);
    await waitForUsableSession(session.page, { timeoutMs, source: describeSessionConfig(config) });
  } catch (error) {
    await session.close().catch(() => {
      // A failure to close must not hide the session problem being reported.
    });
    throw error;
  }

  return session;
}

/**
 * Navigates the page to one Envío Nube app entry point inside the existing
 * session. Shared by the domicilio entry (`ensureAdminPage`) and the sucursal
 * entry (`gotoAgencyEntry`): the navigation is never retried, and a failure is
 * a session problem for a human, not a mystery timeout.
 */
async function gotoAppEntry(page: Page, target: string, timeoutMs: number, entry: string): Promise<void> {
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  } catch (error) {
    throw new SessionError(`could not open the Envío Nube ${entry}`, [
      `target: ${target}`,
      `error: ${messageOf(error)}`,
      'the run does not retry: an unusable session must be fixed by a human',
    ]);
  }
}

/**
 * Frame route of the Envío Nube dashboard inside the app frame. The dashboard
 * is the first hop of the sucursal entry: a hash-only goto re-routes the app
 * SPA only when it mounts or leaves the dashboard (observed live failure:
 * from another hash route the browser treats the goto as a same-document
 * navigation and the app frame stays on the previous screen).
 */
const DASHBOARD_FRAME_ROUTE = '/dashboard';

/**
 * Default short budget (ms) for the dashboard frame-route wait between the two
 * entry hops. The wait is **pacing, not a gate**: the frame mounts on
 * `/dashboard` almost immediately, so a budget of the full goto timeout (60 s)
 * just burned ~60 s doing nothing (measured live: the whole sucursal journey
 * spent 61 s waiting between the hops). Three seconds is enough to let a slow
 * mount land, and hop 2 runs either way — the `/agency-shipment` verdict of
 * `openAgencyEntry` remains the real gate. Overridable for the offline tests.
 */
export const DASHBOARD_WAIT_MS = 3_000;

/** Env switch that overrides the pacing budget; an unusable value falls back to the default. */
export const DASHBOARD_WAIT_VARIABLE = 'MDL_DASHBOARD_WAIT_MS';

/**
 * The URL of the Envío Nube frame when it sits on `route`, or `null`. One
 * non-throwing probe for the bounded dashboard wait below.
 */
function envioNubeFrameUrlOnRoute(page: Page, route: string): string | null {
  const frame = page.frames().find((candidate) => candidate.url().includes(ENVIO_NUBE_FRAME_HOST));
  if (frame === undefined) return null;
  try {
    return new URL(frame.url()).pathname.endsWith(route) ? frame.url() : null;
  } catch {
    return null;
  }
}

async function ensureAdminPage(page: Page, timeoutMs: number): Promise<void> {
  if (page.url().includes('/admin/apps/envionube')) return;
  await gotoAppEntry(page, storeAdminUrl(), timeoutMs, 'manual-shipment entry point');
}

/**
 * Navigates the already-open session to the **sucursal** entry point in two
 * hops (plan §4c, "Sucursal — Screen Entry"). The direct goto to the agency
 * hash alone failed live: the admin page url changed to `#/agency-shipment`
 * but the Envío Nube SPA inside the iframe never re-routed — a goto whose only
 * difference is the hash is a same-document navigation and does not mount a
 * new app route. The operator's manual walk worked because they were on
 * `#/dashboard` first, and from the dashboard the hash change dispatched the
 * SPA router. So the walk is:
 *
 * 1. goto the dashboard entry (`<origin>/admin/apps/envionube/ar#/dashboard`,
 *    the verified dashboard URL constant) and wait, bounded to a **short pacing
 *    budget** (`DASHBOARD_WAIT_MS`, not the goto timeout), for the app frame to
 *    sit on `/dashboard`;
 * 2. goto the agency hash (`#/agency-shipment`).
 *
 * Each hop is a single goto: no hop is ever retried. If the dashboard frame
 * route never appears, the walk still performs the second hop once — the
 * caller's `/agency-shipment` route assertion is the verdict, and its failure
 * evidence carries the frame URL actually reached. Unlike `ensureAdminPage`,
 * this navigates even when the admin app is already open: the current entry
 * hash must be replaced by the dashboard one and then the agency one.
 */
export async function gotoAgencyEntry(page: Page): Promise<void> {
  const timeoutMs = readEnvInt('MDL_WAIT_TIMEOUT_MS', 60_000);
  const dashboardWaitMs = readEnvInt(DASHBOARD_WAIT_VARIABLE, DASHBOARD_WAIT_MS);
  // Hop 1 — the dashboard entry, which mounts the app frame on `/dashboard`.
  await gotoAppEntry(page, adminAppDashboardUrl(), timeoutMs, 'dashboard entry point (#/dashboard)');
  // Short pacing wait for the dashboard frame route, reusing the poll machinery.
  // It spaces the two hops; it is not a gate and never throws — if the frame did
  // not mount on `/dashboard` within the short budget, hop 2 happens anyway
  // (it re-routes from any state), and the agency route assertion decides the
  // outcome. The budget is deliberately NOT the goto timeout: the frame mounts
  // almost immediately, and a full-budget wait here is a dead wait.
  await poll(() => Promise.resolve(envioNubeFrameUrlOnRoute(page, DASHBOARD_FRAME_ROUTE)), { timeoutMs: dashboardWaitMs });
  // Hop 2 — the agency hash, which the SPA re-routes from the dashboard.
  await gotoAppEntry(page, storeAdminAgencyUrl(), timeoutMs, 'sucursal entry point (#/agency-shipment)');
}

export interface UsableSessionOptions {
  timeoutMs: number;
  /** One line naming where the session came from, for the failure details. */
  source: string;
}

/**
 * Detects the two unusable-session shapes the operator cares about: the login
 * page (including the 2FA recovery step) and a missing admin shell. Hidden behind
 * one polling helper so `scripts/session-check.mjs` reports exactly what the
 * executor refuses on.
 */
export async function waitForUsableSession(page: Page, options: UsableSessionOptions): Promise<void> {
  const state = await poll<SessionState>(
    async () => {
      const current = await readSessionState(page);
      if (current === 'ready' || current === 'login' || current === 'login-form') return current;
      return null;
    },
    { timeoutMs: options.timeoutMs },
  );

  if (state === 'ready') return;

  const details = [
    `session: ${options.source}`,
    `page url: ${page.url()}`,
    `detected state: ${state ?? 'the admin shell never became visible'}`,
  ];
  if (state === 'login' || state === 'login-form') {
    throw new SessionError('the browser session is not logged in to the store admin', [
      ...details,
      'login is human-only: the store sends a recovery code (2FA), so this run never automates it and never handles credentials',
      're-seed the session with scripts/session-export.mjs on a machine with a screen, then copy the storageState file again',
    ]);
  }

  throw new SessionError('the store admin shell was not found in the browser session', [
    ...details,
    'expected the admin sidebar with an "Envío Nube" link',
    'the automation does not retry and does not try alternative URLs',
  ]);
}

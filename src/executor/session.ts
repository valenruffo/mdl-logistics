import { chromium, type BrowserContext, type Page } from 'playwright';
import { readEnv, readEnvInt } from './env';
import { ExecutorError, messageOf } from './errors';
import { storeAdminUrl } from './panel';
import { poll } from './wait';

/**
 * The browser session.
 *
 * The executor reuses a **human-prepared, already logged-in Chromium profile**
 * that lives outside the repository (R15). Login is never automated: the store
 * sends a recovery code (2FA), so a human logs in once and this module simply
 * refuses to continue when the session is unusable.
 *
 * An unusable session is a loud `SessionError`, never a login attempt and never
 * a retry loop.
 */

/** Default profile location. Overridable with `MDL_PROFILE`. */
export const DEFAULT_PROFILE_DIR = 'C:\\Users\\valen\\.mdl\\browser-profile';

export class SessionError extends ExecutorError {
  constructor(message: string, details: readonly string[] = []) {
    super(message, details);
    this.name = 'SessionError';
  }
}

export interface Session {
  context: BrowserContext;
  page: Page;
  profileDir: string;
  headless: boolean;
  close(): Promise<void>;
}

export function resolveProfileDir(): string {
  return readEnv('MDL_PROFILE') ?? DEFAULT_PROFILE_DIR;
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

/**
 * Opens the prepared profile and asserts the store admin shell is really there.
 * A profile that Chromium cannot open (for example because another process holds
 * it) is reported as an actionable session problem, not as a mystery timeout.
 */
export async function openSession(): Promise<Session> {
  const profileDir = resolveProfileDir();
  const headless = readEnv('MDL_HEADLESS') === '1';
  const timeoutMs = readEnvInt('MDL_WAIT_TIMEOUT_MS', 60_000);

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless,
      viewport: { width: 1440, height: 900 },
    });
  } catch (error) {
    throw new SessionError(`could not open the prepared browser profile at "${profileDir}"`, [
      `error: ${messageOf(error)}`,
      'the profile holds the logged-in store session and must not be recreated',
      'if another Chromium process is using it (for example scripts/observe.mjs), close that process first and run again',
    ]);
  }

  const page = context.pages()[0] ?? (await context.newPage());

  try {
    await ensureAdminPage(page, timeoutMs);
    await assertUsableSession(page, timeoutMs);
  } catch (error) {
    await context.close().catch(() => {
      // A failure to close must not hide the session problem being reported.
    });
    throw error;
  }

  return {
    context,
    page,
    profileDir,
    headless,
    close: async (): Promise<void> => {
      await context.close();
    },
  };
}

async function ensureAdminPage(page: Page, timeoutMs: number): Promise<void> {
  if (page.url().includes('/admin/apps/envionube')) return;
  const target = storeAdminUrl();
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  } catch (error) {
    throw new SessionError('could not open the Envío Nube manual-shipment entry point', [
      `target: ${target}`,
      `error: ${messageOf(error)}`,
      'the run does not retry: an unusable session must be fixed by a human',
    ]);
  }
}

type ShellState = 'ready' | 'login' | 'login-form' | 'no-shell';

/**
 * Detects the two unusable-session shapes the operator cares about: the login
 * page (including the 2FA recovery step) and a missing admin shell.
 */
async function assertUsableSession(page: Page, timeoutMs: number): Promise<void> {
  const shellLink = page.getByRole('link', { name: /Envío Nube/i }).first();

  const state = await poll<ShellState>(
    async () => {
      if (looksLikeLoginUrl(page.url())) return 'login';
      if ((await page.locator('input[type="password"]').count().catch(() => 0)) > 0) return 'login-form';
      if ((await shellLink.count()) === 0) return null;
      return (await shellLink.isVisible()) ? 'ready' : null;
    },
    { timeoutMs },
  );

  if (state === 'ready') return;

  const details = [
    `profile: ${resolveProfileDir()}`,
    `page url: ${page.url()}`,
    `detected state: ${state ?? 'the admin shell never became visible'}`,
  ];
  if (state === 'login' || state === 'login-form') {
    throw new SessionError('the prepared browser profile is not logged in to the store admin', [
      ...details,
      'login is human-only: the store sends a recovery code (2FA), so this run never automates it and never handles credentials',
      'open the profile by hand once, complete the login, close it, and run again',
    ]);
  }

  throw new SessionError('the store admin shell was not found in the prepared profile', [
    ...details,
    'expected the admin sidebar with an "Envío Nube" link',
    'the automation does not retry and does not try alternative URLs',
  ]);
}

/**
 * Ops check: is the session on this machine usable right now?
 *
 * This is what runs before trusting a deployment. It opens the app entry point
 * with **the same configuration the server uses** (`MDL_STORE_ORIGIN`,
 * `MDL_STORAGE_STATE`, `MDL_HEADLESS`, all resolved by the env layer), then
 * reports whether the session is usable:
 *
 *  - the store admin shell is reachable (no login page, no 2FA prompt);
 *  - the Envío Nube app frame loads from the dashboard URL.
 *
 * It does not click, fill, create or purchase anything. Read-only by construction.
 *
 * Run (on the server, in the container):
 *   npm run session-check
 *
 * Exit codes, so a supervisor or a deploy script can branch on them:
 *   0  usable session
 *   1  the session is not usable (login page, 2FA prompt, missing admin shell,
 *      app frame not reachable)
 *   2  configuration refused before any browser was opened (invalid switch,
 *      missing MDL_STORE_ORIGIN, missing/unreadable MDL_STORAGE_STATE)
 *   3  the browser could not start at all (missing Chromium, no display with
 *      MDL_HEADLESS unset, sandbox problem)
 */
import { adminAppDashboardUrl, ENVIO_NUBE_FRAME_HOST, resolveStoreOrigin } from '../src/executor/panel.ts';
import {
  describeSessionConfig,
  openSession,
  readSessionState,
  resolveSessionConfig,
} from '../src/executor/session.ts';

const DASHBOARD_TIMEOUT_MS = 30_000;
const PROBE_INTERVAL_MS = 500;

const EXIT = { usable: 0, unusable: 1, badConfig: 2, noBrowser: 3 };

const STATE_LABEL = {
  ready: 'sesión utilizable (panel del admin visible)',
  login: 'página de login',
  'login-form': 'formulario de login / código de recuperación (2FA)',
  'no-admin-shell': 'panel del admin no visible',
};

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function fail(message, details = []) {
  console.error(`ERROR: ${message}`);
  for (const detail of details) console.error(`  - ${detail}`);
}

/** The 2FA surfaces: the recovery-code URL and the code inputs themselves. */
async function twoFactorPrompt(page) {
  const selectors = [
    'input[autocomplete="one-time-code"]',
    'input[name*="recovery" i]',
    'input[name*="verification" i]',
    'input[name*="otp" i]',
  ];
  for (const selector of selectors) {
    if ((await page.locator(selector).count().catch(() => 0)) > 0) return selector;
  }
  return null;
}

function appFrameUrls(page) {
  const urls = [];
  for (const frame of page.frames()) {
    if (frame.url().includes(ENVIO_NUBE_FRAME_HOST)) urls.push(frame.url());
  }
  return urls;
}

async function checkDashboard(page) {
  let navigationError = null;
  try {
    await page.goto(adminAppDashboardUrl(), { waitUntil: 'domcontentloaded', timeout: DASHBOARD_TIMEOUT_MS });
  } catch (error) {
    // A redirect to the login page is reported by the state probe below; a real
    // navigation failure is kept as evidence instead of aborting the check.
    navigationError = error.message;
  }

  const deadline = Date.now() + DASHBOARD_TIMEOUT_MS;
  for (;;) {
    const state = await readSessionState(page).catch(() => 'no-admin-shell');
    const prompt = state === 'ready' ? await twoFactorPrompt(page) : null;
    const frames = appFrameUrls(page);

    if (state === 'ready' && prompt === null && frames.length > 0) {
      return { ok: true, state, prompt: null, frames, navigationError };
    }
    if (Date.now() >= deadline) {
      return { ok: false, state, prompt, frames, navigationError };
    }
    await sleep(PROBE_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------- 1. config

let config;
try {
  config = resolveSessionConfig();
  resolveStoreOrigin();
} catch (error) {
  fail(error.message, error.details ?? []);
  console.error('\nLa configuración se rechaza antes de abrir el navegador: no se tocó nada.');
  process.exit(EXIT.badConfig);
}

console.log('MDL Logistics — chequeo de sesión (sólo lectura)');
console.log(`  ${describeSessionConfig(config)}`);
console.log('  nunca inicia sesión, nunca crea un envío, nunca compra nada.');

// --------------------------------------------------------------- 2. session

let session;
try {
  session = await openSession();
} catch (error) {
  const details = error.details ?? [];
  if (/could not open the browser/.test(error.message)) {
    fail(error.message, details);
    console.error('\nEl navegador no pudo arrancar. En el servidor eso suele ser MDL_HEADLESS sin definir,');
    console.error('un Chromium que no está instalado, o un problema de sandbox en el contenedor.');
    process.exit(EXIT.noBrowser);
  }
  fail(error.message, details);
  console.error('\nEl punto de entrada de la app no es utilizable con esta sesión.');
  process.exit(EXIT.unusable);
}

let exitCode = EXIT.unusable;

try {
  const result = await checkDashboard(session.page);
  const state = result.state;

  console.log(`  estado: ${STATE_LABEL[state] ?? state}`);
  console.log(`  url: ${session.page.url()}`);
  for (const url of result.frames) console.log(`  frame de la app: ${url}`);
  if (result.prompt !== null) console.log(`  prompt de 2FA detectado: ${result.prompt}`);
  if (result.navigationError !== null) console.log(`  aviso: la navegación al dashboard falló (${result.navigationError})`);

  if (!result.ok) {
    const details = [
      `estado detectado: ${STATE_LABEL[state] ?? state}`,
      `url: ${session.page.url()}`,
      ...(result.navigationError === null ? [] : [`navegación al dashboard: ${result.navigationError}`]),
      result.frames.length === 0
        ? `ningún frame del navegador contiene "${ENVIO_NUBE_FRAME_HOST}"`
        : `frames de la app: ${result.frames.join(', ')}`,
    ];
    if (result.prompt !== null) details.push(`prompt de 2FA: ${result.prompt}`);
    if (state === 'login' || state === 'login-form' || result.prompt !== null) {
      details.push('la sesión venció o está a mitad de login: re-exportala con scripts/session-export.mjs');
    }
    fail('la sesión no es utilizable en este momento', details);
    exitCode = EXIT.unusable;
  } else {
    const dashboardEvidence = result.frames.some((url) => url.toLowerCase().includes('dashboard'));
    if (!dashboardEvidence) {
      console.log('  aviso: la ruta del frame no contiene "dashboard"; la app cargó, confirmá la ruta a mano.');
    }
    console.log('\nOK: la sesión es utilizable.');
    exitCode = EXIT.usable;
  }
} finally {
  await session.close().catch(() => {});
}

process.exit(exitCode);

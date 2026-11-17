/**
 * Exports a human-prepared login as a Playwright `storageState` file.
 *
 * Why this exists: the store sends a recovery code (2FA), so login is human and
 * stays human. The automation never handles credentials. A person with a screen
 * opens the store admin here, logs in by hand, and the resulting session is
 * written to one file that can be carried to the server.
 *
 * The file is **credential material**: anyone holding it can act as the operator
 * in the store admin. Copy it over an encrypted channel, keep it readable only by
 * the runtime user, mount it read-only into the container, and never commit it
 * (R15: `.gitignore` already covers `**\/storageState*.json`).
 *
 * Run locally (headed, persistent profile, exactly the local mode):
 *   npm run session-export -- ./session/storage-state.json
 *
 * Exit codes: 0 exported, 1 the login never completed / export failed, 2 usage or
 * configuration refused before the browser was opened.
 */
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { adminAppDashboardUrl } from '../src/executor/panel.ts';
import {
  openBrowserSession,
  readSessionState,
  resolveProfileDir,
} from '../src/executor/session.ts';

const LOGIN_TIMEOUT_MS = 15 * 60_000;
const PROBE_INTERVAL_MS = 2_000;

const USAGE = [
  'uso: npm run session-export -- <archivo-storage-state.json>',
  '',
  '  Abre el admin de la tienda en un Chromium con ventana, usando el perfil local',
  '  (MDL_PROFILE, por defecto el perfil de siempre). Iniciá sesión a mano, incluido',
  '  el código de recuperación (2FA), y el archivo se escribe cuando el panel del',
  '  admin está visible.',
  '',
  '  Requiere MDL_STORE_ORIGIN, igual que la aplicación.',
].join('\n');

const STATE_LABEL = {
  ready: 'sesión utilizable (panel del admin visible)',
  login: 'página de login',
  'login-form': 'formulario de login / código de recuperación',
  'no-admin-shell': 'panel del admin todavía no visible',
};

function fail(message, details = []) {
  console.error(`\nERROR: ${message}`);
  for (const detail of details) console.error(`  - ${detail}`);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const target = process.argv[2];

if (target === '--help' || target === '-h') {
  console.log(USAGE);
  process.exit(0);
}

if (target === undefined || target.startsWith('-')) {
  console.error('falta el archivo de destino');
  console.error(USAGE);
  process.exit(2);
}

const targetPath = path.resolve(target);

let dashboardUrl;
try {
  dashboardUrl = adminAppDashboardUrl();
} catch (error) {
  fail(error.message, error.details ?? []);
  console.error('\nNo se abrió el navegador: la configuración se rechaza antes de tocar nada.');
  process.exit(2);
}

console.log('MDL Logistics — exportar la sesión a un archivo');
console.log(`  perfil local: ${resolveProfileDir()}`);
console.log(`  destino:      ${targetPath}`);
console.log('  el navegador se abre con ventana: iniciá sesión a mano, 2FA incluido.');

let session;
try {
  session = await openBrowserSession({
    mode: 'persistent-profile',
    headless: false,
    profileDir: resolveProfileDir(),
    storageStatePath: null,
  });
} catch (error) {
  fail(error.message, error.details ?? []);
  console.error('\nNo se abrió el navegador. Cerrá cualquier otro Chromium que use el mismo perfil');
  console.error('(por ejemplo scripts/observe.mjs) y volvé a intentar.');
  process.exit(1);
}

const page = session.page;
let exitCode = 0;

try {
  try {
    await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  } catch (error) {
    // A redirect to the login page is the normal starting point, not a failure.
    console.log(`  aviso: la navegación inicial no terminó limpia (${error.message})`);
    console.log('  seguimos: lo que importa es que puedas iniciar sesión en esta ventana.');
  }

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let previousState = null;
  let state = await readSessionState(page).catch(() => 'no-admin-shell');

  while (state !== 'ready') {
    if (Date.now() >= deadline) {
      fail(`la sesión no quedó utilizable en ${Math.round(LOGIN_TIMEOUT_MS / 60_000)} minutos`, [
        `estado detectado: ${STATE_LABEL[state] ?? state}`,
        `url de la página: ${page.url()}`,
        'no se escribió ningún archivo: una sesión a medio iniciar no sirve en el servidor',
      ]);
      exitCode = 1;
      break;
    }

    if (state !== previousState) {
      console.log(`  estado: ${STATE_LABEL[state] ?? state} — esperando...`);
      previousState = state;
    }

    await sleep(PROBE_INTERVAL_MS);
    state = await readSessionState(page).catch(() => 'no-admin-shell');
  }

  if (state === 'ready') {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await session.context.storageState({ path: targetPath });

    const { size } = await stat(targetPath);
    const kib = (size / 1024).toFixed(1);

    console.log(`\nOK: sesión exportada a ${targetPath}`);
    console.log(`  tamaño: ${size} bytes (${kib} KiB)`);
    console.log('');
    console.log('ADVERTENCIA: este archivo es material de credencial.');
    console.log('  - Cualquiera que lo tenga puede actuar como el operador en el admin de la tienda.');
    console.log('  - No se commitea, no se pega en un chat, no se manda por mail sin cifrar.');
    console.log('  - Copialo al servidor por un canal cifrado y dejalo legible sólo por el usuario del runtime:');
    console.log('      scp storage-state.json operador@servidor:/ruta/fuera-del-repo/storage-state.json');
    console.log('      ssh operador@servidor chmod 600 /ruta/fuera-del-repo/storage-state.json');
    console.log('  - En el servidor se pasa como MDL_STORAGE_STATE y se monta read-only en el contenedor.');
    console.log('  - Cuando la sesión expire, repetí este script y volvé a copiar el archivo.');
  }
} finally {
  await session.close().catch(() => {});
}

process.exit(exitCode);

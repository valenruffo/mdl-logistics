/**
 * `npm run ui` — starts the maintenance console on `127.0.0.1` and prints where
 * it is.
 *
 * The executor is wired lazily: Playwright is only imported when a run actually
 * starts, so the page, the analyze/approve steps and the whole console (runtime,
 * session, runs, artifacts, errors, health) work without the browser stack being
 * loaded. The console's readers are given plain paths here — the artifacts tree,
 * the session-check history and the run-record directory — and nothing else is
 * read: no secret, no session, no credential. The session lives in the Playwright
 * profile or the transferred storageState file, both outside the repository, and
 * the console only `stat`s them.
 *
 * Only the port is an option. The host is not: this page can create shipments.
 *
 * The process also refuses to start without `MDL_PASSWORD_HASH` and
 * `MDL_SESSION_SECRET`. There is no default password and no default secret: a
 * default would be a published credential, so the only answer is to stop and name
 * the variable that is missing. The messages never quote a value.
 */
import { ARTIFACTS_DIR } from './console';
import { RUN_RECORD_DIR } from '../cli/runRecord';
import type { ActionDeps, UiExecutor } from './actions';
import {
  AuthConfigError,
  PASSWORD_HASH_COMMAND,
  PASSWORD_HASH_VARIABLE,
  SESSION_SECRET_COMMAND,
  SESSION_SECRET_VARIABLE,
  readAuthConfig,
  type AuthConfig,
} from './auth';
import { DEFAULT_PORT, startUiServer } from './server';
import { QUEUE_DIR, queueFor } from './queue';
import { SESSION_CHECK_HISTORY_PATH, runSessionCheckScript } from './sessionCheck';

const executor: UiExecutor = {
  runDryRun: async (input) => (await import('../executor/run')).runDryRun(input),
  runCreate: async (input) => (await import('../executor/run')).runCreate(input),
};

const deps: ActionDeps = {
  executor,
  recordDir: RUN_RECORD_DIR,
  console: {
    artifactsDir: ARTIFACTS_DIR,
    sessionCheckHistoryPath: SESSION_CHECK_HISTORY_PATH,
    sessionCheckRunner: runSessionCheckScript,
  },
};

// The queue starts with the process, not with the first request: entries stacked
// before a restart are recovered and drained as soon as the console is up.
queueFor(deps);

function usage(): string {
  return [
    `uso: npm run ui              (escucha en 127.0.0.1:${DEFAULT_PORT})`,
    '     npm run ui -- --port 4400',
    '     npm run ui -- --help',
    'no hay opcion de host: la pagina puede crear envios y solo escucha en loopback.',
    '',
    `para arrancar hacen falta ${PASSWORD_HASH_VARIABLE} y ${SESSION_SECRET_VARIABLE}:`,
    `  ${PASSWORD_HASH_VARIABLE}=$( ${PASSWORD_HASH_COMMAND} )`,
    `  ${SESSION_SECRET_VARIABLE}=$( ${SESSION_SECRET_COMMAND} )`,
  ].join('\n');
}

/**
 * Reads the login configuration, or explains which variable is missing and how to
 * generate it. Returns `null` when the process must not serve anything.
 */
function requireAuthConfig(): AuthConfig | null {
  try {
    return readAuthConfig(process.env);
  } catch (error) {
    if (!(error instanceof AuthConfigError)) throw error;
    console.error(`No se puede arrancar la consola: ${error.message}.`);
    console.error('No hay contraseña ni secreto por defecto: el servidor no sirve nada sin ellos.');
    console.error(`  ${PASSWORD_HASH_VARIABLE}: ${PASSWORD_HASH_COMMAND}`);
    console.error(`  ${SESSION_SECRET_VARIABLE}: ${SESSION_SECRET_COMMAND}`);
    return null;
  }
}

interface ParsedArgs {
  port: number;
  help: boolean;
  error: string | null;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let port = DEFAULT_PORT;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') return { port, help: true, error: null };

    if (arg === '--port') {
      const raw = argv[index + 1];
      const value = Number(raw);
      if (raw === undefined || !Number.isInteger(value) || value <= 0 || value > 65535) {
        return { port, help: false, error: `puerto invalido: ${JSON.stringify(raw ?? null)}` };
      }
      port = value;
      index += 1;
      continue;
    }

    return { port, help: false, error: `argumento desconocido: ${arg}` };
  }

  return { port, help: false, error: null };
}

const args = parseArgs(process.argv.slice(2));
const auth = args.error === null && !args.help ? requireAuthConfig() : null;

if (args.error !== null) {
  console.error(args.error);
  console.error(usage());
  process.exitCode = 2;
} else if (args.help) {
  console.log(usage());
  process.exitCode = 0;
} else if (auth === null) {
  // The message that names the missing variable is already printed.
  process.exitCode = 2;
} else {
  const started = await startUiServer({ port: args.port, deps, auth });

  console.log('MDL Logistics — consola de mantenimiento');
  console.log(`  ${started.url}`);
  console.log('  escucha solo en 127.0.0.1 porque esta pagina puede crear envios.');
  console.log(`  entrada: ${started.url}/login (cookie de sesion de 30 dias, HttpOnly, Secure, SameSite=Strict)`);
  console.log('  la cookie es Secure a proposito: un navegador que abra http://127.0.0.1 directo NO la conserva.');
  console.log('  uso local: entrá por el proxy TLS o por un tunel SSH (ver env.example); no hay forma de apagar Secure.');
  console.log('  un solo password se verifica a la vez; los intentos se cuentan por cliente, no por el proxy.');
  console.log(`  registros de ejecucion: ${RUN_RECORD_DIR}`);
  console.log(`  cola de envios: ${QUEUE_DIR} (persistente: sobrevive reinicios, se crea de a uno)`);
  console.log(`  artefactos: ${ARTIFACTS_DIR} (se listan en la pagina; no se sirven por HTTP)`);
  console.log(`  historial del chequeo de sesion: ${SESSION_CHECK_HISTORY_PATH}`);
  console.log('  el chequeo de sesion abre un navegador: solo corre con el boton de la pagina.');
  console.log('  Ctrl+C para detener.');
}

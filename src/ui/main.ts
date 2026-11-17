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
 */
import { ARTIFACTS_DIR } from './console';
import { RUN_RECORD_DIR } from '../cli/runRecord';
import type { ActionDeps, UiExecutor } from './actions';
import { DEFAULT_PORT, startUiServer } from './server';
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

function usage(): string {
  return [
    `uso: npm run ui              (escucha en 127.0.0.1:${DEFAULT_PORT})`,
    '     npm run ui -- --port 4400',
    '     npm run ui -- --help',
    'no hay opcion de host: la pagina puede crear envios y solo escucha en loopback.',
  ].join('\n');
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

if (args.error !== null) {
  console.error(args.error);
  console.error(usage());
  process.exitCode = 2;
} else if (args.help) {
  console.log(usage());
  process.exitCode = 0;
} else {
  const started = await startUiServer({ port: args.port, deps });

  console.log('MDL Logistics — consola de mantenimiento');
  console.log(`  ${started.url}`);
  console.log('  escucha solo en 127.0.0.1 porque esta pagina puede crear envios.');
  console.log(`  registros de ejecucion: ${RUN_RECORD_DIR}`);
  console.log(`  artefactos: ${ARTIFACTS_DIR} (descarga de solo lectura en /artifacts/)`);
  console.log(`  historial del chequeo de sesion: ${SESSION_CHECK_HISTORY_PATH}`);
  console.log('  el chequeo de sesion abre un navegador: solo corre con el boton de la pagina.');
  console.log('  Ctrl+C para detener.');
}

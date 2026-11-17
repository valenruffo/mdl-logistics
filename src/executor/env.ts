/**
 * Environment access without `@types/node` (see globals.d.ts).
 *
 * Only the executor reads the environment: the store admin origin, session
 * profile path, headless switch, transferred storage-state path and wait
 * timeouts. Nothing here is a secret — the profile and the storage state *hold*
 * the session, but their locations are configuration, not credentials.
 *
 * Every switch is read here, once, so the executor has a single place where an
 * env value is validated. A malformed value is a loud `EnvError`, never a silent
 * default: a run that quietly interpreted `MDL_HEADLESS=1` as "headed" would try
 * to open a display on a server that has none.
 */
import { ExecutorError } from './errors';

/** Raised when an environment variable is present but unusable. */
export class EnvError extends ExecutorError {
  constructor(message: string, details: readonly string[] = []) {
    super(message, details);
    this.name = 'EnvError';
  }
}

interface ProcessLike {
  env: Record<string, string | undefined>;
}

const processLike = (globalThis as unknown as { process?: ProcessLike }).process;

/** Reads a variable, treating an empty/whitespace value as absent. */
export function readEnv(name: string): string | undefined {
  const raw = processLike?.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Reads a boolean variable that accepts exactly `true` and `false`
 * (case-insensitive, surrounding whitespace ignored). Absent or empty means
 * `fallback`; anything else is refused.
 */
export function readEnvBool(name: string, fallback: boolean): boolean {
  const raw = readEnv(name);
  if (raw === undefined) return fallback;

  const normalized = raw.toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;

  throw new EnvError(`the environment variable ${name} is not a boolean`, [
    `received: ${JSON.stringify(raw)}`,
    'accepted values: true, false',
    `unset or empty means the default (${String(fallback)})`,
    'the value is refused instead of guessed: a misread switch would either try to open a display that does not exist or silently stop honouring the intended mode',
  ]);
}

/** Reads a positive integer variable, falling back when absent or unusable. */
export function readEnvInt(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

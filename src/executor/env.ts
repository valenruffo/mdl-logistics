/**
 * Environment access without `@types/node` (see globals.d.ts).
 *
 * Only the executor reads the environment: the store admin origin, session
 * profile path, headless opt-in and wait timeouts. Nothing here is a secret —
 * the profile *holds* the session, but its location is configuration, not a
 * credential.
 */
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

/** Reads a positive integer variable, falling back when absent or unusable. */
export function readEnvInt(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

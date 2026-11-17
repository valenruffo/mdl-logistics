/**
 * Waiting primitives.
 *
 * The rule for this executor is "wait for observable state, never a fixed
 * sleep". `poll` is a condition wait: it re-probes an observable predicate
 * until it holds or the deadline passes, and returns `null` on timeout so the
 * caller can raise an `ExecutorError` that names what the panel actually
 * showed. `sleep` only spaces the probes; it is never the wait itself.
 */

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export interface PollOptions {
  timeoutMs: number;
  intervalMs?: number;
}

/**
 * Probes `probe` until it returns a non-null value or `timeoutMs` elapses.
 * A probe that throws is treated as "not yet": a detached frame or a
 * mid-navigation page is a normal transient, not a verdict.
 */
export async function poll<T>(probe: () => Promise<T | null>, options: PollOptions): Promise<T | null> {
  const intervalMs = options.intervalMs ?? 250;
  const deadline = Date.now() + options.timeoutMs;

  for (;;) {
    let value: T | null;
    try {
      value = await probe();
    } catch {
      value = null;
    }
    if (value !== null) return value;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

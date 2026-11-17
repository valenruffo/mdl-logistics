/**
 * The in-process single-flight lock for everything that starts a browser.
 *
 * Why it exists: `POST /api/session-check` used to start a fresh Chromium on
 * every request, with no exclusion against `/api/run`. The documented 2 GB
 * container is sized for **one** Chromium, so two concurrent checks — or a check
 * during an in-flight creation — could exhaust memory and have the process
 * killed mid-run. If the creation died after its pre-click record was written,
 * that attempt was left unresolved with nobody to resolve it.
 *
 * The rule is therefore: one holder at a time, one message when the lock is
 * busy, and a guarantee that the lock comes back. `withBrowserLock` releases in
 * a `finally`, so a success, a refusal, a failure and a throw all free it —
 * including the executor throwing right after it wrote its pre-click record.
 *
 * The lock is process-wide (`browserLock`) because the resource it protects —
 * the machine's memory and the one Chromium budget — is process-wide too.
 */

/**
 * What a second request gets while the lock is held. One sentence, in the
 * operator's language, saying what is happening, what to do and that nothing
 * changed. Exported so the page and the tests can quote it exactly.
 */
export const LOCK_BUSY_MESSAGE =
  'ya hay una corrida en curso en este proceso (chequeo de sesión o recorrido del panel): el contenedor está dimensionado para un solo Chromium. Esperá a que termine — su estado se lee en GET /api/console — y volvé a intentar; no se cambió nada.';

/** What holds the lock, as the two routes name themselves. */
export type BrowserHolder = 'run' | 'session-check';

export interface LockLease {
  ok: true;
  holder: BrowserHolder;
  /** Idempotent: releasing twice is a no-op, never a lock leak or a double free. */
  release(): void;
}

export interface LockRefused {
  ok: false;
  /** The holder that has it right now; never empty when `ok` is false. */
  holder: BrowserHolder | null;
  reason: string;
}

export type LockResult = LockLease | LockRefused;

export class SingleFlightLock {
  private holderName: BrowserHolder | null = null;

  /** The current holder, or `null` when the lock is free. */
  get holder(): BrowserHolder | null {
    return this.holderName;
  }

  get free(): boolean {
    return this.holderName === null;
  }

  tryAcquire(holder: BrowserHolder): LockResult {
    const current = this.holderName;
    if (current !== null) return { ok: false, holder: current, reason: LOCK_BUSY_MESSAGE };

    this.holderName = holder;
    let released = false;
    const lock = this;

    return {
      ok: true,
      holder,
      release(): void {
        if (released) return;
        released = true;
        // Only the holder that still owns it may clear it, so a late release
        // cannot free a lock an older request already gave back.
        if (lock.holderName === holder) lock.holderName = null;
      },
    };
  }
}

/** The one lock of this process. Both browser routes take it, nothing else does. */
export const browserLock = new SingleFlightLock();

export type BrowserWork<T> = { ok: true; value: T };

/**
 * Runs `work` while holding the lock, or refuses without running it at all.
 *
 * The `finally` is the whole point: whatever `work` does — return, refuse, fail
 * or throw — the lock is free afterwards, so one bad run cannot wedge the page
 * for the rest of the process's life.
 */
export async function withBrowserLock<T>(
  holder: BrowserHolder,
  work: () => Promise<T>,
  lock: SingleFlightLock = browserLock,
): Promise<BrowserWork<T> | LockRefused> {
  const lease = lock.tryAcquire(holder);
  if (!lease.ok) return lease;

  try {
    return { ok: true, value: await work() };
  } finally {
    lease.release();
  }
}

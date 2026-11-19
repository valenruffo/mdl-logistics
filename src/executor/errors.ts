/**
 * The single error type of the executor layer.
 *
 * Every failure carries `details`: the observations that make the stop
 * actionable (frame URL, visible headings, suspected bot challenge, artifact
 * paths). A bare message would force the operator to guess what the panel
 * showed, and this layer is not allowed to guess.
 */
export class ExecutorError extends Error {
  readonly details: readonly string[];

  constructor(message: string, details: readonly string[] = []) {
    super(message);
    this.name = 'ExecutorError';
    this.details = details;
  }
}

/**
 * Raised when `Crear envío` was clicked (once) and the shipment detail page was
 * not reached. The outcome is genuinely unknown: the shipment may or may not
 * exist. The caller must reconcile against the shipments list — never retry,
 * never click again.
 */
export class UnknownOutcomeError extends ExecutorError {
  constructor(message: string, details: readonly string[] = []) {
    super(message, details);
    this.name = 'UnknownOutcomeError';
  }
}

/**
 * Raised when the run aborted **before** the `Crear envío` click (R10 as
 * amended). The click is the only action that can create a shipment, so an
 * abort at this stage cannot have created one: the caller records the outcome
 * as `not-created` automatically instead of leaving an unresolved record for a
 * human to reconcile. `stage` names how far the run got, so the automatic
 * resolution carries a reason, not a bare status.
 */
export class PreClickAbortError extends ExecutorError {
  readonly stage: string;

  constructor(stage: string, message: string, details: readonly string[] = []) {
    super(message, details);
    this.name = 'PreClickAbortError';
    this.stage = stage;
  }
}

/**
 * Classifies any error as a pre-click abort, preserving its message and
 * details. Idempotent: an already-classified abort passes through unchanged so
 * wrapping layers never lose the original stage.
 */
export function asPreClickAbort(stage: string, error: unknown): PreClickAbortError {
  if (error instanceof PreClickAbortError) return error;
  return new PreClickAbortError(stage, messageOf(error), detailsOf(error));
}

/** Narrow unknown thrown values to a message without importing @types/node. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Details of an `ExecutorError`; empty for anything else. */
export function detailsOf(error: unknown): string[] {
  return error instanceof ExecutorError ? [...error.details] : [];
}

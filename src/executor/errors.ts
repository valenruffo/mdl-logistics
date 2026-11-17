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

/** Narrow unknown thrown values to a message without importing @types/node. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Details of an `ExecutorError`; empty for anything else. */
export function detailsOf(error: unknown): string[] {
  return error instanceof ExecutorError ? [...error.details] : [];
}

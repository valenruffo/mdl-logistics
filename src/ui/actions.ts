/**
 * The server logic behind the one page (plan §6: paste, review, approve, run).
 *
 * Everything irreversible is *reused*, never reimplemented:
 *
 * - gate 1 is `assertApprovalHash` from `src/cli/gates.ts`. The approval hash is
 *   always recomputed here, from the values posted with the request. A client
 *   that keeps an old hash after an edit gets a refusal, and there is no state on
 *   the server that could remember "it was approved a moment ago";
 * - gate 2 is `assertConfirmationToken`, and it runs on its own, after gate 1,
 *   immediately before the attempt record is written;
 * - the prior-attempt check is `assertNoBlockingPriorAttempt` over
 *   `loadRunRecords`, so an unresolved record blocks the creation exactly as it
 *   does from the CLI;
 * - the durable record is `writeAttemptRecord` / `writeOutcomeRecord`, written
 *   before and after the click.
 *
 * The executor is injected so this module can be tested without a browser: the
 * page never imports Playwright itself.
 *
 * Nothing here creates anything on its own — `runAttempt` is the only function
 * that can, and only when both gates pass.
 */
import {
  GateRefused,
  assertApprovalHash,
  assertConfirmationToken,
  assertNoBlockingPriorAttempt,
  computeApprovalHash,
  confirmationTokenFor,
  describeApprovalPayload,
  messageFingerprint,
  type ExistingRun,
} from '../cli/gates';
import {
  attemptRecordPath,
  loadRunRecords,
  outcomeRecordPath,
  writeAttemptRecord,
  writeOutcomeRecord,
  type RunOutcomeRecord,
} from '../cli/runRecord';
import { CARRIER_NAME } from '../core/carrier';
import { parseMessage } from '../core/parse-message';
import { PROVINCE_OPTIONS } from '../core/provinces';
import type { ParseWarning, ShipmentRequest } from '../core/types';
import { approvalPayloadFromRequest } from '../executor/approval';
import { labelUnpaidProblem, type CardReadback } from '../executor/envioNube';
import { ExecutorError, UnknownOutcomeError, detailsOf, messageOf } from '../executor/errors';
import type { CreateRunResult, DryRunResult, RunOptions } from '../executor/run';
import { formFieldsFromRequest, requestFromForm, type FormField, type FormIssue, type FormValues } from './form';

/** The executor surface the page needs. Injected, so tests never open a browser. */
export interface UiExecutor {
  runDryRun(input: RunOptions): Promise<DryRunResult>;
  runCreate(input: RunOptions): Promise<CreateRunResult>;
}

export interface ActionDeps {
  executor: UiExecutor;
  /** Where the durable run records live (`artifacts/run-records` in production). */
  recordDir: string;
}

function refusalOf(stage: RefusalStage, error: unknown): RunResponse {
  if (error instanceof GateRefused) {
    return { status: 'refused', stage, reason: error.message, details: [...error.details] };
  }
  return {
    status: 'failed',
    reason: reasonOf(error),
    details: detailsOf(error),
    recordPath: null,
    note: 'the run stopped before anything was written',
  };
}

function reasonOf(error: unknown): string {
  if (error instanceof ExecutorError) return `${error.name}: ${error.message}`;
  return `unexpected error: ${messageOf(error)}`;
}

// ------------------------------------------------------------------- analyze

export interface MissingItem {
  field: string;
  label: string;
  reason: string;
}

export interface InvalidItem {
  field: string;
  label: string;
  value: string;
  reason: string;
}

export interface WarningItem {
  code: string;
  anchor: string | null;
  message: string;
}

/** A rejection: every category is shown with its reason, and nothing is actionable. */
export interface AnalyzeRejected {
  status: 'rejected';
  missing: MissingItem[];
  invalid: InvalidItem[];
  unknownLabels: string[];
}

/** A parsed message: the prefilled, editable preview. */
export interface AnalyzeParsed {
  status: 'parsed';
  fields: FormField[];
  /** The panel's own province options, so the select can never offer a wrong one. */
  provinces: { code: string; name: string }[];
  warnings: WarningItem[];
  carrier: string;
}

export type AnalyzeResponse = AnalyzeRejected | AnalyzeParsed;

function messageOfMissing(label: string, anchor: string | undefined): string {
  const where = anchor === undefined ? '' : ` (campo del panel: ${anchor})`;
  return `el mensaje no trae la línea «${label}»${where}`;
}

function warningItem(warning: ParseWarning): WarningItem {
  return {
    code: warning.code,
    anchor: warning.anchor === undefined ? null : warning.anchor,
    message: warning.message,
  };
}

/**
 * Parses one pasted message (S1, S2).
 *
 * A rejection carries the parser's own reasons verbatim: the operator has to see
 * *why* the message was refused, not a generic failure.
 */
export function analyzeMessage(message: string): AnalyzeResponse {
  const parsed = parseMessage(message);

  if (!parsed.ok) {
    return {
      status: 'rejected',
      missing: parsed.missing.map((item) => ({
        field: item.field,
        label: item.label,
        reason: messageOfMissing(item.label, item.anchor),
      })),
      invalid: parsed.invalid.map((item) => ({
        field: item.field,
        label: item.label,
        value: item.value,
        reason: item.reason,
      })),
      unknownLabels: [...parsed.unknownLabels],
    };
  }

  return {
    status: 'parsed',
    fields: formFieldsFromRequest(parsed.value),
    provinces: PROVINCE_OPTIONS.map((option) => ({ code: option.code, name: option.name })),
    warnings: parsed.warnings.map(warningItem),
    carrier: CARRIER_NAME,
  };
}

// ------------------------------------------------------------------- approve

export interface ApproveInput {
  message: string;
  form: FormValues;
}

export type ApproveResponse =
  | {
      status: 'approved';
      /** sha-256 of the payload described below, computed here and never posted in. */
      approvalHash: string;
      payload: { field: string; value: string }[];
      /** The canonical values behind the hash, so the page can show exactly them. */
      values: Record<string, string>;
      /** An open prior attempt for the same message, as a heads-up. */
      note: string | null;
    }
  | { status: 'invalid-form'; errors: FormIssue[] };

/**
 * Gate 1, the data approval.
 *
 * The hash is computed from the values in *this* request. Approving does not
 * authorize anything: the token gate is a separate call, and an edit between the
 * two produces a different hash, which the run refuses.
 */
export async function approveForm(input: ApproveInput, deps: ActionDeps): Promise<ApproveResponse> {
  const built = requestFromForm(input.form);
  if (!built.ok) return { status: 'invalid-form', errors: built.errors };

  const request = built.value;
  const approvalHash = computeApprovalHash(request);
  const payload = describeApprovalPayload(approvalPayloadFromRequest(request, CARRIER_NAME));

  return {
    status: 'approved',
    approvalHash,
    payload,
    values: built.values,
    note: await openPriorAttemptsNote(input.message, deps),
  };
}

/**
 * Open attempts for the same message, as a note. Reading is fail-closed
 * elsewhere; here a broken directory is reported instead of hidden, and the
 * creation path will refuse on its own.
 */
async function openPriorAttemptsNote(message: string, deps: ActionDeps): Promise<string | null> {
  let records: ExistingRun[];
  try {
    records = await loadRunRecords(deps.recordDir);
  } catch (error) {
    return `los registros de ejecución no se pudieron leer (${messageOf(error)}): la creación va a rechazarse hasta que se arregle ${deps.recordDir}`;
  }
  return openPriorAttemptNote(records, messageFingerprint(message));
}

function openPriorAttemptNote(records: readonly ExistingRun[], messageHash: string): string | null {
  const open = records.filter(
    (record) => record.messageHash === messageHash && (record.outcome === null || record.outcome.status !== 'not-created'),
  );
  if (open.length === 0) return null;

  const names = open.map((record) => `${record.runId} (${record.outcome?.status ?? 'attempted-unresolved'})`).join(', ');
  return `${open.length} earlier run(s) for this exact message are still open: ${names}. The create path refuses until a human resolves them.`;
}

// ----------------------------------------------------------------------- run

export type RunMode = 'dry-run' | 'create';

export interface RunInput {
  message: string;
  form: FormValues;
  mode: RunMode;
  /** The hash the page received when the data was approved. Never trusted. */
  approvedHash: string | null | undefined;
  /** The typed confirmation token; ignored for a dry run. */
  token?: string | null;
}

export type RefusalStage = 'approval' | 'prior-attempt' | 'confirmation';

export interface RefusedResponse {
  status: 'refused';
  stage: RefusalStage;
  reason: string;
  details: string[];
}

export interface DryRunResponse {
  status: 'dry-run';
  /** The dry run's terminal state: the panel summary. Nothing was created. */
  summaryReached: true;
  approvedHash: string;
  currentHash: string;
  formMatchesApproval: boolean;
  mismatches: string[];
  reportPath: string;
  note: string | null;
}

export interface CreatedResponse {
  status: 'created';
  shipmentId: string;
  statusBadges: string[];
  cost: { summary: string | null; detail: string | null };
  labelUnpaid: {
    /** True when all three structural checks hold (id, badge, label control). */
    proven: boolean;
    /** `null` when proven; otherwise the reason the proof does not hold. */
    problem: string | null;
    details: string[];
  };
  reportPath: string;
  detailScreenshot: string | null;
  recordPath: string;
  outcomePath: string;
}

export interface UnknownResponse {
  status: 'unknown';
  reason: string;
  details: string[];
  matches: string[];
  interpretation: string;
  recordPath: string;
  outcomePath: string;
  note: string;
}

export interface FailedResponse {
  status: 'failed';
  reason: string;
  /** The executor's own details, verbatim, so the real cause is never summarized away. */
  details: string[];
  /** The record file to inspect, when one was already written. */
  recordPath: string | null;
  note: string;
}

export type RunResponse =
  | { status: 'invalid-form'; errors: FormIssue[] }
  | RefusedResponse
  | DryRunResponse
  | CreatedResponse
  | UnknownResponse
  | FailedResponse;

const SUMMARY_MODALITY_CARD = 'Modalidad de envío';
const DETAIL_SHIPMENT_CARD = 'Datos del envío';

function cardText(cards: readonly CardReadback[], title: string): string | null {
  return cards.find((card) => card.title === title)?.text ?? null;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function recordNote(recordPath: string): string {
  return `el registro ${recordPath} queda attempted-unresolved a propósito: revisá la lista de envíos antes de repetir este mensaje`;
}

/**
 * Runs one attempt.
 *
 * Order matters and mirrors the CLI: rebuild the payload, recompute its hash and
 * verify the approval, check prior attempts, then — only for a creation — the
 * typed token, then the durable record, then the panel.
 */
export async function runAttempt(input: RunInput, deps: ActionDeps): Promise<RunResponse> {
  const built = requestFromForm(input.form);
  if (!built.ok) return { status: 'invalid-form', errors: built.errors };

  const request: ShipmentRequest = built.value;
  const currentHash = computeApprovalHash(request);

  let approvedHash: string;
  try {
    approvedHash = assertApprovalHash(input.approvedHash ?? null, currentHash);
  } catch (error) {
    return refusalOf('approval', error);
  }

  const messageHash = messageFingerprint(input.message);

  let records: ExistingRun[];
  try {
    records = await loadRunRecords(deps.recordDir);
  } catch (error) {
    return refusalOf('prior-attempt', error);
  }

  if (input.mode === 'create') {
    try {
      assertNoBlockingPriorAttempt(records, messageHash);
    } catch (error) {
      return refusalOf('prior-attempt', error);
    }
  }
  const note = openPriorAttemptNote(records, messageHash);

  if (input.mode === 'dry-run') return await dryRun(request, approvedHash, currentHash, note, deps);

  let typedToken: string;
  try {
    typedToken = assertConfirmationToken(input.token ?? null, confirmationTokenFor(request));
  } catch (error) {
    return refusalOf('confirmation', error);
  }

  return await create(request, messageHash, approvedHash, typedToken, input.token ?? '', deps);
}

async function dryRun(
  request: ShipmentRequest,
  approvedHash: string,
  currentHash: string,
  note: string | null,
  deps: ActionDeps,
): Promise<RunResponse> {
  let result: DryRunResult;
  try {
    result = await deps.executor.runDryRun({ request, approvedPayloadHash: approvedHash });
  } catch (error) {
    return {
      status: 'failed',
      reason: reasonOf(error),
      details: detailsOf(error),
      recordPath: null,
      note: 'la prueba en seco no crea nada: no se escribió ningún registro de ejecución',
    };
  }

  return {
    status: 'dry-run',
    summaryReached: true,
    approvedHash,
    currentHash,
    formMatchesApproval: result.formMatchesApproval,
    mismatches: [...result.mismatches],
    reportPath: result.reportPath,
    note: result.formMatchesApproval ? note : `el panel no tiene el payload aprobado. ${note ?? ''}`.trim(),
  };
}

async function create(
  request: ShipmentRequest,
  messageHash: string,
  approvedHash: string,
  expectedToken: string,
  typedToken: string,
  deps: ActionDeps,
): Promise<RunResponse> {
  const runId = `${stamp()}-${messageHash.slice(0, 12)}`;
  const recordPath = attemptRecordPath(deps.recordDir, runId);
  const outcomePath = outcomeRecordPath(deps.recordDir, runId);

  try {
    await writeAttemptRecord(deps.recordDir, {
      runId,
      recordedAt: new Date().toISOString(),
      messageFile: '(pasted in the UI)',
      messageHash,
      approvalHash: approvedHash,
      payload: approvalPayloadFromRequest(request, CARRIER_NAME),
      confirmation: { expected: expectedToken, typed: typedToken.trim() },
      status: 'attempted-unresolved',
      note: 'written before the click; whether the button was clicked is only known to the process that died',
    });
  } catch (error) {
    return {
      status: 'failed',
      reason: `the run record could not be written, so the click was not attempted: ${messageOf(error)}`,
      details: [],
      recordPath: null,
      note: `revisá los permisos de ${deps.recordDir}`,
    };
  }

  let result: CreateRunResult;
  try {
    result = await deps.executor.runCreate({ request, approvedPayloadHash: approvedHash });
  } catch (error) {
    if (error instanceof UnknownOutcomeError) {
      await writeOutcome(deps, {
        runId,
        finishedAt: new Date().toISOString(),
        status: 'unknown',
        shipmentId: null,
        costShown: { summaryModality: null, detailShipmentData: null },
        buyButtonVisible: false,
        buyCardText: null,
        reconciliation: null,
        reportPath: '',
        recordedBy: 'executor',
      });
      return {
        status: 'unknown',
        reason: reasonOf(error),
        details: detailsOf(error),
        matches: [],
        interpretation: 'the run stopped before any reconciliation could be read',
        recordPath,
        outcomePath,
        note: `compará a mano la lista de envíos con el registro ${recordPath}. No se reintenta nada.`,
      };
    }

    return {
      status: 'failed',
      reason: reasonOf(error),
      details: detailsOf(error),
      recordPath,
      note: recordNote(recordPath),
    };
  }

  if (result.outcome === 'unknown') {
    const reconciliation = result.reconciliation;
    await writeOutcome(deps, {
      runId,
      finishedAt: result.finishedAt,
      status: 'unknown',
      shipmentId: null,
      costShown: { summaryModality: null, detailShipmentData: null },
      buyButtonVisible: false,
      buyCardText: null,
      reconciliation,
      reportPath: result.reportPath,
      recordedBy: 'executor',
    });
    return {
      status: 'unknown',
      reason: 'the create button was clicked once and the shipment detail page was never reached',
      details: [`report: ${result.reportPath}`],
      matches: [...reconciliation.matches],
      interpretation: reconciliation.interpretation,
      recordPath,
      outcomePath,
      note: `una sola lectura de conciliación es evidencia, no un veredicto. Revisá la lista de envíos y resolvé ${outcomePath} a mano.`,
    };
  }

  const shipment = result.shipment;
  const cost = {
    summaryModality: cardText(result.journey.summary.cards, SUMMARY_MODALITY_CARD),
    detailShipmentData: cardText(shipment.cards, DETAIL_SHIPMENT_CARD),
  };

  await writeOutcome(deps, {
    runId,
    finishedAt: result.finishedAt,
    status: 'created',
    shipmentId: shipment.shipmentId,
    costShown: cost,
    buyButtonVisible: shipment.buyButtonVisible,
    buyCardText: shipment.buyCardText,
    reconciliation: null,
    reportPath: result.reportPath,
    recordedBy: 'executor',
  });

  const problem = labelUnpaidProblem(shipment);

  return {
    status: 'created',
    shipmentId: shipment.shipmentId,
    statusBadges: [...shipment.statusBadges],
    cost: { summary: cost.summaryModality, detail: cost.detailShipmentData },
    labelUnpaid: {
      proven: problem === null,
      problem: problem === null ? null : problem.message,
      details: problem === null ? [] : problem.details,
    },
    reportPath: result.reportPath,
    detailScreenshot: result.detailScreenshot,
    recordPath,
    outcomePath,
  };
}

async function writeOutcome(deps: ActionDeps, outcome: RunOutcomeRecord): Promise<void> {
  try {
    await writeOutcomeRecord(deps.recordDir, outcome);
  } catch {
    // The attempt record is the one that matters for the gate; a missing outcome
    // keeps the run fail-closed, which is the safe direction.
  }
}

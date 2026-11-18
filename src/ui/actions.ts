/**
 * The server logic behind the one page: analyze, then run.
 *
 * Creating a shipment in Envío Nube costs nothing, so it needs no ceremony
 * (R10 as amended): the operator pastes, reviews, edits and clicks `Crear envío`.
 * There is no approval hash to re-post and no typed token anywhere in this path.
 * Buying the label does cost money, it stays forbidden, and nothing in this
 * module can reach it: the executor's create journey stops on the detail page.
 *
 * What this path *does* keep is everything that prevents a duplicate shipment,
 * and all of it is reused from `src/cli/` instead of reimplemented:
 *
 * - the prior-attempt check is `assertNoBlockingPriorAttempt` over
 *   `loadRunRecords`, so an unresolved record for the same message — and a record
 *   that already created one — blocks the creation exactly as it does from the
 *   CLI;
 * - the durable record is `writeAttemptRecord` / `writeOutcomeRecord`, written
 *   before and after the click, so an interrupted run is visible instead of
 *   silent;
 * - the payload hash is still computed here from the values that were on screen
 *   and handed to the executor, which recomputes it from the panel readback. That
 *   is an integrity check between the page and the panel, not a human gate.
 *
 * The CLI keeps its own two gates (`assertApprovalHash`,
 * `assertConfirmationToken`): `npm run ship` is a different surface and nothing
 * here weakens it.
 *
 * The executor is injected so this module can be tested without a browser: the
 * page never imports Playwright itself.
 */
import {
  GateRefused,
  assertNoBlockingPriorAttempt,
  computeApprovalHash,
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
import type { ConsoleOverrides } from './console';
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
  /**
   * Overrides for the maintenance console's reads (artifacts root, session-check
   * history, the injected check runner). Every field has the repository's own
   * default, so a caller that only runs the create path keeps working unchanged.
   */
  console?: ConsoleOverrides;
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

/**
 * Open attempts for the same message, as a heads-up shown next to the run. The
 * refusal itself is the gate's job; this is the sentence that explains why it
 * would refuse, before the operator clicks.
 */
function openPriorAttemptNote(records: readonly ExistingRun[], messageHash: string): string | null {
  const open = records.filter(
    (record) => record.messageHash === messageHash && (record.outcome === null || record.outcome.status !== 'not-created'),
  );
  if (open.length === 0) return null;

  const names = open.map((record) => `${record.runId} (${record.outcome?.status ?? 'attempted-unresolved'})`).join(', ');
  return `${open.length} earlier run(s) for this exact message are still open: ${names}. The create path refuses until a human resolves them.`;
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

// ----------------------------------------------------------------------- run

export type RunMode = 'dry-run' | 'create';

/**
 * What the page posts to `/api/run`.
 *
 * Just the message, the values on screen and the mode. No hash to echo back, no
 * token to type: those were the creation ceremony, and creation costs nothing.
 */
export interface RunInput {
  message: string;
  form: FormValues;
  mode: RunMode;
}

/** A refusal raised by a gate that prevents a duplicate shipment. */
export type RefusalStage = 'prior-attempt';

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
  /** The hash of the payload that was walked to the summary. */
  payloadHash: string;
  /** True when the panel's own readback hashes to the same payload. */
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
 * Order matters and mirrors the CLI minus its two human gates: rebuild the
 * payload from the values on screen, fingerprint the message, read the records,
 * refuse an unresolved or already-created attempt for that message, then write
 * the pre-click record and touch the panel.
 *
 * `Probar en seco` stops at the panel summary and writes no record at all: it is
 * the path with no side effects.
 */
export async function runAttempt(input: RunInput, deps: ActionDeps): Promise<RunResponse> {
  const built = requestFromForm(input.form);
  if (!built.ok) return { status: 'invalid-form', errors: built.errors };

  const request: ShipmentRequest = built.value;
  // Integrity only: the executor recomputes this from the panel readback, so a
  // page that shows one payload and a panel that receives another is caught.
  const payloadHash = computeApprovalHash(request);
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

  if (input.mode === 'dry-run') return await dryRun(request, payloadHash, note, deps);

  return await create(request, messageHash, payloadHash, deps);
}

async function dryRun(
  request: ShipmentRequest,
  payloadHash: string,
  note: string | null,
  deps: ActionDeps,
): Promise<RunResponse> {
  let result: DryRunResult;
  try {
    result = await deps.executor.runDryRun({ request, approvedPayloadHash: payloadHash });
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
    payloadHash,
    formMatchesApproval: result.formMatchesApproval,
    mismatches: [...result.mismatches],
    reportPath: result.reportPath,
    note: result.formMatchesApproval ? note : `el panel no tiene el payload que muestra la página. ${note ?? ''}`.trim(),
  };
}

async function create(
  request: ShipmentRequest,
  messageHash: string,
  payloadHash: string,
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
      approvalHash: payloadHash,
      payload: approvalPayloadFromRequest(request, CARRIER_NAME),
      // No confirmation: this surface has no typed token, by design (R10 as
      // amended). The CLI still records the one it asks for.
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
    result = await deps.executor.runCreate({ request, approvedPayloadHash: payloadHash });
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

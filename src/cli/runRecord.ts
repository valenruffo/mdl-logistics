/**
 * The durable run record (plan §6: the ledger is written *before* the panel is
 * touched, so an interrupted run is visible instead of silent).
 *
 * Two files per run, both plain JSON under `artifacts/run-records/` (git-ignored,
 * like everything else in `artifacts/`):
 *
 * - `<runId>.json` — written **before** the `Crear envío` click. It holds the
 *   timestamp, the message hash, the payload hash, the full payload and — when the
 *   CLI asked for one — the confirmation the operator typed. If the process dies
 *   mid-click, this is the only trace that a shipment may have been created.
 * - `<runId>.outcome.json` — added only once an outcome is known: `created` with
 *   the `#EM<number>`, or `unknown` with the single reconciliation report. A
 *   human adds `not-created` by hand after checking the shipment list.
 *
 * A record without an outcome file is `attempted-unresolved` and blocks any new
 * run for the same message hash (`assertNoBlockingPriorAttempt`). Reading is
 * fail-closed: an unparseable record aborts the run instead of quietly
 * disappearing from the gate.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

import type { ApprovalPayload, SucursalApprovalPayload } from '../executor/approval';
import { GateRefused } from './gates';
import type { ExistingRun, RunOutcomeStatus } from './gates';

/** Where run records live. Fixed: no environment variable, no flag. */
export const RUN_RECORD_DIR = 'artifacts/run-records';

const OUTCOME_SUFFIX = '.outcome.json';
const ATTEMPT_SUFFIX = '.json';

/** The pre-click record. Never rewritten: the outcome goes in its own file. */
export interface ApprovalRunRecord {
  runId: string;
  recordedAt: string;
  messageFile: string;
  /** sha-256 of the message text (line-ending churn normalized away). */
  messageHash: string;
  /** sha-256 of the approved payload — the same value the executor re-checks. */
  approvalHash: string;
  /** The full approved payload, not just its hash. Either modality's shape. */
  payload: ApprovalPayload | SucursalApprovalPayload;
  /**
   * The token the CLI asks the operator to type. **Absent** for the local page,
   * where creating a shipment needs no ceremony (R10 as amended); `loadRunRecords`
   * already tolerates a record without it.
   */
  confirmation?: { expected: string; typed: string };
  status: 'attempted-unresolved';
  note: string;
}

/** What the panel had to say about the run, once it said anything at all. */
export interface RunOutcomeRecord {
  runId: string;
  finishedAt: string;
  status: RunOutcomeStatus;
  shipmentId: string | null;
  costShown: { summaryModality: string | null; detailShipmentData: string | null };
  /** `Comprar` visibility: it is asserted, never clicked. */
  buyButtonVisible: boolean;
  buyCardText: string | null;
  reconciliation: unknown;
  reportPath: string;
  recordedBy: 'executor' | 'human';
}

export function attemptRecordPath(dir: string, runId: string): string {
  return `${dir}/${runId}${ATTEMPT_SUFFIX}`;
}

export function outcomeRecordPath(dir: string, runId: string): string {
  return `${dir}/${runId}${OUTCOME_SUFFIX}`;
}

/** Writes the pre-click record and returns its path. */
export async function writeAttemptRecord(dir: string, record: ApprovalRunRecord): Promise<string> {
  await mkdir(dir, { recursive: true });
  const target = attemptRecordPath(dir, record.runId);
  await writeFile(target, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8' });
  return target;
}

/** Adds the outcome next to the pre-click record. The pre-click file is left intact. */
export async function writeOutcomeRecord(dir: string, outcome: RunOutcomeRecord): Promise<string> {
  await mkdir(dir, { recursive: true });
  const target = outcomeRecordPath(dir, outcome.runId);
  await writeFile(target, `${JSON.stringify(outcome, null, 2)}\n`, { encoding: 'utf8' });
  return target;
}

const OUTCOME_STATUSES: readonly RunOutcomeStatus[] = ['created', 'unknown', 'not-created'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Reads every run record in `dir`, joining each pre-click record with its outcome
 * when one exists. A missing directory is "no attempts". An unreadable or
 * malformed file is a hard refusal: dropping it would silently reopen the gate
 * for a message that may already have a shipment.
 */
export async function loadRunRecords(dir: string): Promise<ExistingRun[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw new GateRefused(`could not read the run-record directory ${dir}`, [describeError(error)]);
  }

  const attempts = entries.filter((name) => name.endsWith(ATTEMPT_SUFFIX) && !name.endsWith(OUTCOME_SUFFIX)).sort();
  const outcomes = new Set(entries.filter((name) => name.endsWith(OUTCOME_SUFFIX)));

  const records: ExistingRun[] = [];
  for (const name of attempts) {
    const runId = name.slice(0, -ATTEMPT_SUFFIX.length);
    const path = `${dir}/${name}`;

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, { encoding: 'utf8' }));
    } catch (error) {
      throw new GateRefused(`the run record ${path} could not be parsed`, [
        describeError(error),
        'the record may describe a shipment that already exists, so the run stops instead of guessing',
      ]);
    }

    if (!isRecord(parsed) || textOf(parsed, 'messageHash') === null || textOf(parsed, 'approvalHash') === null) {
      throw new GateRefused(`the run record ${path} could not be parsed`, [
        'expected an object with at least messageHash and approvalHash',
        'the record may describe a shipment that already exists, so the run stops instead of guessing',
      ]);
    }

    const confirmation = isRecord(parsed['confirmation']) ? parsed['confirmation'] : null;
    const record: ExistingRun = {
      runId: textOf(parsed, 'runId') ?? runId,
      recordedAt: textOf(parsed, 'recordedAt') ?? '(not recorded)',
      messageHash: textOf(parsed, 'messageHash') ?? '',
      approvalHash: textOf(parsed, 'approvalHash') ?? '',
      confirmationToken:
        confirmation === null
          ? ''
          : (textOf(confirmation, 'typed') ?? textOf(confirmation, 'expected') ?? ''),
      outcome: null,
    };

    const outcomeName = `${runId}${OUTCOME_SUFFIX}`;
    if (outcomes.has(outcomeName)) {
      records.push({ ...record, outcome: await readOutcome(`${dir}/${outcomeName}`) });
    } else {
      records.push(record);
    }
  }

  return records;
}

async function readOutcome(path: string): Promise<ExistingRun['outcome']> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, { encoding: 'utf8' }));
  } catch (error) {
    throw new GateRefused(`the run outcome ${path} could not be parsed`, [
      describeError(error),
      'an unreadable outcome is treated as unresolved, and an unreadable record stops the run',
    ]);
  }

  if (!isRecord(parsed)) {
    throw new GateRefused(`the run outcome ${path} could not be parsed`, ['expected a JSON object']);
  }

  const status = textOf(parsed, 'status');
  if (status === null || !OUTCOME_STATUSES.includes(status as RunOutcomeStatus)) {
    throw new GateRefused(`the run outcome ${path} has an unusable status`, [
      `received: ${JSON.stringify(parsed['status'] ?? null)}`,
      `expected one of: ${OUTCOME_STATUSES.join(', ')}`,
    ]);
  }

  return {
    status: status as RunOutcomeStatus,
    finishedAt: textOf(parsed, 'finishedAt') ?? '(not recorded)',
    shipmentId: textOf(parsed, 'shipmentId'),
  };
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error['code'] === 'ENOENT';
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

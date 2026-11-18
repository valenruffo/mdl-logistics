/**
 * `npm run ship` — the operator-facing CLI for the create path (R10, S10).
 *
 * Three invocations, in order:
 *
 * 1. `--message <file>` (the default, no `--approve`)
 *    Parse, print every panel field with its value, print the approval hash, and
 *    **stop**. The panel is never opened, so this is safe to run for anyone.
 * 2. `--message <file> --approve <hash> --dry-run`
 *    Re-parse, recompute the hash, refuse on any difference, then walk the real
 *    journey up to the summary and stop. Nothing is created.
 * 3. `--message <file> --approve <hash>`
 *    Same hash gate, then the second and different gate: the operator must type
 *    `<postal code> crear`. Only then is a durable run record written and the
 *    create click allowed.
 *
 * Playwright is imported lazily, so gate 1 works (and is testable) without the
 * browser stack loaded.
 */
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';

import { CARRIER_NAME } from '../core/carrier';
import { parseMessage } from '../core/parse-message';
import type { ShipmentRequest } from '../core/types';
import { approvalPayloadFromRequest, type ApprovalPayload } from '../executor/approval';
import type { CardReadback } from '../executor/envioNube';
import { ExecutorError, UnknownOutcomeError, detailsOf, messageOf } from '../executor/errors';
import type { CreateRunResult, DryRunResult } from '../executor/run';
import {
  GateRefused,
  USAGE,
  assertApprovalHash,
  assertConfirmationToken,
  assertNoBlockingPriorAttempt,
  computeApprovalHash,
  confirmationTokenFor,
  describeApprovalPayload,
  messageFingerprint,
  parseCliArgs,
  type CliArgs,
} from './gates';
import {
  RUN_RECORD_DIR,
  attemptRecordPath,
  loadRunRecords,
  outcomeRecordPath,
  writeAttemptRecord,
  writeOutcomeRecord,
  type RunOutcomeRecord,
} from './runRecord';

const BANNER = 'MDL Logistics — manual shipment';

function section(title: string): void {
  console.log(`\n${title}`);
}

function row(label: string, value: string): void {
  console.log(`  ${label.padEnd(28)} ${value === '' ? '(empty)' : value}`);
}

function printUsage(): void {
  console.log(BANNER);
  console.log('\nusage:');
  for (const line of USAGE) console.log(`  ${line}`);
  console.log('\nthere is no flag, environment variable or config switch that skips the approval or the confirmation.');
}

/** Prints a gate refusal and the reason, and returns the process exit code. */
function refuse(error: unknown): number {
  if (error instanceof GateRefused) {
    console.error(`\nREFUSED: ${error.message}`);
    for (const detail of error.details) console.error(`  - ${detail}`);
    return 2;
  }
  console.error('\nREFUSED: unexpected error while evaluating the gates');
  console.error(error);
  return 2;
}

function printPayload(payload: ApprovalPayload): void {
  section('Resolved payload — exactly these values will be typed into Envío Nube');
  for (const field of describeApprovalPayload(payload)) row(field.field, field.value);
}

function printParseNotes(request: ShipmentRequest, messagePath: string, warnings: readonly string[]): void {
  const derived = request.derived ?? [];
  if (derived.length === 0 && warnings.length === 0) return;

  section('Derived and flagged values (confirm them in the approval)');
  for (const derivation of derived) {
    console.log(`  derived  ${derivation.anchor}: ${derivation.note} (${derivation.rule})`);
  }
  for (const warning of warnings) console.log(`  warning  ${warning}`);
  console.log(`  source   ${messagePath}`);
}

function cardText(cards: readonly CardReadback[], title: string): string | null {
  return cards.find((card) => card.title === title)?.text ?? null;
}

function costShown(result: CreateRunResult & { outcome: 'created' }): RunOutcomeRecord['costShown'] {
  return {
    summaryModality: cardText(result.journey.summary.cards, 'Modalidad de envío'),
    detailShipmentData: cardText(result.shipment.cards, 'Datos del envío'),
  };
}

/** Reads one line from the operator. An unusable stdin yields `''`, which the gate refuses. */
async function askLine(prompt: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await readline.question(prompt);
  } catch {
    return '';
  } finally {
    readline.close();
  }
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    return refuse(error);
  }

  if (args.help) {
    printUsage();
    return 0;
  }

  console.log(BANNER);
  row('mode', args.mode);
  row('message file', args.messagePath);

  let messageText: string;
  try {
    messageText = await readFile(args.messagePath, { encoding: 'utf8' });
  } catch (error) {
    console.error(`\nREFUSED: the message file could not be read: ${messageOf(error)}`);
    console.error(`  path: ${args.messagePath}`);
    console.error('  nothing was parsed, the panel was not opened and nothing was created');
    return 2;
  }

  const parsed = parseMessage(messageText);
  if (!parsed.ok) {
    console.error('\nREFUSED by the parser; the panel was not opened and nothing was created.');
    for (const missing of parsed.missing) console.error(`  missing: ${missing.label}`);
    for (const invalid of parsed.invalid) console.error(`  invalid: ${invalid.label}: ${invalid.reason}`);
    for (const unknown of parsed.unknownLabels) console.error(`  unknown label: ${unknown}`);
    return 1;
  }

  const request = parsed.value;

  // The CLI drives the domicilio journey only. A sucursal message stops here,
  // before anything is hashed: the sucursal executor comes after a DOM
  // discovery pass, and building a domicilio payload from sucursal data would
  // be exactly the invented data R12 forbids.
  if (request.modality === 'sucursal') {
    console.error('\nREFUSED: este mensaje es de envío a sucursal y la carga a sucursal todavía no está implementada en esta versión');
    console.error('  nothing was hashed, the panel was not opened and nothing was created');
    return 2;
  }

  const payload = approvalPayloadFromRequest(request, CARRIER_NAME);
  const approvalHash = computeApprovalHash(request);
  const messageHash = messageFingerprint(messageText);

  printParseNotes(
    request,
    args.messagePath,
    parsed.warnings.map((warning) => warning.message),
  );
  printPayload(payload);
  row('message hash', messageHash);
  row('approval hash', approvalHash);

  // Gate 1 is the operator's approval of this exact payload.
  let verifiedHash: string | null = null;
  if (args.mode !== 'preview') {
    try {
      verifiedHash = assertApprovalHash(args.approve, approvalHash);
    } catch (error) {
      return refuse(error);
    }
    console.log('\nAPPROVAL VERIFIED: --approve matches the payload above, byte for byte.');
  }

  if (args.mode === 'preview') {
    section('STOPPED — nothing has been run and nothing was created');
    console.log('  approve the data by re-running with the hash above:');
    console.log(`    npm run ship -- --message "${args.messagePath}" --approve ${approvalHash} --dry-run`);
    console.log('  then, when you mean to create the shipment:');
    console.log(`    npm run ship -- --message "${args.messagePath}" --approve ${approvalHash}`);
    console.log('  any edit to the message changes the payload, so this hash stops working.');
    try {
      const note = await priorAttemptNote(messageHash, false);
      if (note !== '') console.log(`\nnote: ${note}`);
    } catch (error) {
      // An unreadable record fails closed here too, even though nothing runs yet.
      return refuse(error);
    }
    return 0;
  }

  let priorWarning: string | null = null;
  try {
    // In the create path an open prior run throws; in a dry run it only warns,
    // because a dry run creates nothing.
    priorWarning = await priorAttemptNote(messageHash, args.mode === 'create');
  } catch (error) {
    return refuse(error);
  }

  const { runCreate, runDryRun } = await import('../executor/run');

  if (args.mode === 'dry-run') {
    if (priorWarning !== null) console.log(`\nnote: ${priorWarning}`);
    section('DRY RUN — walking screens 1-4 and stopping on the summary; nothing is created');
    try {
      const result: DryRunResult = await runDryRun({
        request,
        approvedPayloadHash: verifiedHash ?? approvalHash,
      });
      row('form payload hash', result.formPayloadHash);
      row('form matches approval', String(result.formMatchesApproval));
      row('mismatches', String(result.mismatches.length));
      for (const mismatch of result.mismatches) console.log(`    - ${mismatch}`);
      row('create button visible', `${result.createButtonPresent} (never clicked)`);
      row('report', result.reportPath);
      if (!result.formMatchesApproval || result.mismatches.length > 0) {
        console.error('\nFAILED: the panel does not hold the approved payload. Nothing was created.');
        return 1;
      }
      console.log('\nSTOPPED ON THE SUMMARY: no shipment was created and no label was purchased.');
      return 0;
    } catch (error) {
      return reportExecutorStop(error);
    }
  }

  // ------------------------------------------------------------- create path
  // The prior-attempt gate runs before the panel and before the prompt: a message
  // that may already have a shipment is never driven again automatically.
  if (priorWarning !== null) console.log(`\nnote: ${priorWarning}`);

  const expectedToken = confirmationTokenFor(request);
  section('Second gate — authorize the creation');
  console.log('  approving the data is not the same as authorizing the click.');
  console.log(`  type exactly: ${JSON.stringify(expectedToken)}`);
  const typed = await askLine(`  ${expectedToken} > `);
  try {
    assertConfirmationToken(typed, expectedToken);
  } catch (error) {
    return refuse(error);
  }

  const runId = `${stamp()}-${messageHash.slice(0, 12)}`;
  try {
    await writeAttemptRecord(RUN_RECORD_DIR, {
      runId,
      recordedAt: new Date().toISOString(),
      messageFile: args.messagePath,
      messageHash,
      approvalHash: verifiedHash ?? approvalHash,
      payload,
      confirmation: { expected: expectedToken, typed: typed.trim() },
      status: 'attempted-unresolved',
      note: 'written before the create click; whether the button was clicked is only known to the process that died',
    });
  } catch (error) {
    console.error(`\nREFUSED: the run record could not be written, so the create click was not attempted: ${messageOf(error)}`);
    return 2;
  }

  row('run record', attemptRecordPath(RUN_RECORD_DIR, runId));
  console.log('  (this record is written before the click: if the process dies, it is the only trace)');

  section('Driving the panel — one creation attempt, never retried');
  try {
    const result = await runCreate({ request, approvedPayloadHash: verifiedHash ?? approvalHash });
    return await recordOutcome(runId, result);
  } catch (error) {
    // An unknown outcome already carries its own single reconciliation attempt in
    // `runCreate`. Either way the record stays unresolved on purpose.
    return reportExecutorStop(error, {
      runId,
      record: attemptRecordPath(RUN_RECORD_DIR, runId),
    });
  }
}

/**
 * What previous runs for this message hash have to say.
 *
 * With `blocking` (the create path) an open, unknown or already-created prior run
 * throws and the run stops. Without it (preview and dry run, which create
 * nothing) the same state is only reported.
 */
async function priorAttemptNote(messageHash: string, blocking: boolean): Promise<string> {
  const records = await loadRunRecords(RUN_RECORD_DIR);
  if (blocking) assertNoBlockingPriorAttempt(records, messageHash);

  const sameMessage = records.filter((record) => record.messageHash === messageHash);
  const open = sameMessage.filter((record) => record.outcome === null || record.outcome.status !== 'not-created');
  if (open.length > 0) {
    const names = open.map((record) => `${record.runId} (${record.outcome?.status ?? 'attempted-unresolved'})`).join(', ');
    return `WARNING: ${open.length} earlier run(s) for this exact message are still open: ${names}. The create path refuses until a human resolves them.`;
  }
  const resolved = sameMessage.filter((record) => record.outcome?.status === 'not-created');
  if (resolved.length === 0) return '';
  return `${resolved.length} earlier run(s) for this message were resolved as "not-created" by a human; this is a new attempt`;
}

/** Records the outcome durably and returns the exit code. */
async function recordOutcome(runId: string, result: CreateRunResult): Promise<number> {
  if (result.outcome === 'unknown') {
    await writeOutcomeSafely({
      runId,
      finishedAt: result.finishedAt,
      status: 'unknown',
      shipmentId: null,
      costShown: { summaryModality: null, detailShipmentData: null },
      buyButtonVisible: false,
      buyCardText: null,
      reconciliation: result.reconciliation,
      reportPath: result.reportPath,
      recordedBy: 'executor',
    });
    section('OUTCOME UNKNOWN — the shipment may or may not exist');
    console.log('  the create button was clicked once and the shipment detail page was never reached.');
    console.log('  one read-only reconciliation was attempted against the dashboard; it is evidence, not a verdict:');
    row('matches found', String(result.reconciliation.matches.length));
    for (const match of result.reconciliation.matches) console.log(`    - ${match}`);
    row('interpretation', result.reconciliation.interpretation);
    row('report', result.reportPath);
    row('run record (stays unresolved)', attemptRecordPath(RUN_RECORD_DIR, runId));
    console.log('\n  reconcile by hand against the Envío Nube shipment list. Nothing is retried automatically.');
    return 1;
  }

  const shown = costShown(result);
  await writeOutcomeSafely({
    runId,
    finishedAt: result.finishedAt,
    status: 'created',
    shipmentId: result.shipment.shipmentId,
    costShown: shown,
    buyButtonVisible: result.shipment.buyButtonVisible,
    buyCardText: result.shipment.buyCardText,
    reconciliation: null,
    reportPath: result.reportPath,
    recordedBy: 'executor',
  });

  section('CREATED — the label is pending payment and nothing was purchased');
  row('shipment id', result.shipment.shipmentId);
  row('status badges', result.shipment.statusBadges.join(', ') || '(none read)');
  row('cost shown (summary)', shown.summaryModality ?? '(not read)');
  row('cost shown (detail)', shown.detailShipmentData ?? '(not read)');
  row('label card', result.shipment.buyCardText ?? '(not read)');
  row('Comprar visible', `${result.shipment.buyButtonVisible} — inspected, never clicked`);
  row('executor report', result.reportPath);
  row('detail screenshot', result.detailScreenshot ?? '(not captured)');
  row('run record', attemptRecordPath(RUN_RECORD_DIR, runId));
  row('outcome record', outcomeRecordPath(RUN_RECORD_DIR, runId));

  if (!result.shipment.buyButtonVisible) {
    console.error('\nINCOMPLETE: the shipment was created but the "Comprar" button is not visible,');
    console.error('so "the label is unpaid" cannot be proven from this screen. Check the panel by hand.');
    return 1;
  }

  console.log('\nTERMINAL STATE: shipment created, label unpaid. Purchase is not implemented, by design.');
  return 0;
}

async function writeOutcomeSafely(outcome: RunOutcomeRecord): Promise<void> {
  try {
    await writeOutcomeRecord(RUN_RECORD_DIR, outcome);
  } catch (error) {
    console.error(`\nWARNING: the outcome could not be written next to the run record: ${messageOf(error)}`);
    console.error(`  write it by hand: ${outcomeRecordPath(RUN_RECORD_DIR, outcome.runId)}`);
  }
}

function reportExecutorStop(error: unknown, context?: { runId: string; record: string }): number {
  if (error instanceof UnknownOutcomeError) {
    console.error(`\nSTOPPED — UNKNOWN OUTCOME: ${error.message}`);
  } else if (error instanceof ExecutorError) {
    console.error(`\nSTOPPED: ${error.name}: ${error.message}`);
  } else {
    console.error('\nSTOPPED: unexpected error');
    console.error(error);
  }
  for (const detail of detailsOf(error)) console.error(`  - ${detail}`);

  if (context !== undefined) {
    console.error(`\n  the run record ${context.record} stays attempted-unresolved on purpose.`);
    console.error('  do not re-run this message blindly: check the shipment list first, then have a human');
    console.error(`  write ${outcomeRecordPath(RUN_RECORD_DIR, context.runId)} with status "not-created" or "created".`);
  }
  return 1;
}

process.exitCode = await main();

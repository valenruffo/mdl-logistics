/**
 * The two gates of the create path, as pure logic (R10, S10).
 *
 * There are exactly two human actions between a validated message and a created
 * shipment, and neither can be produced by the program itself:
 *
 * 1. **Approve the data.** The first invocation prints the resolved payload and
 *    its sha-256 hash, then stops. The operator re-runs with `--approve <hash>`;
 *    the hash is recomputed over the freshly parsed payload and must match. Any
 *    edit to the message in between changes the payload, so the approval is
 *    invalidated by construction — nothing has to remember what was approved.
 * 2. **Authorize the creation.** Immediately before the click the operator types
 *    `<postal code> crear`. Anything else aborts with nothing clicked.
 *
 * Nothing in this module touches the file system, the browser or the network, so
 * both gates are testable offline. It deliberately has no "force" path: there is
 * no flag, environment variable or option anywhere that skips a gate.
 */
import { createHash } from 'node:crypto';

import type { ShipmentRequest } from '../core/types';
import { approvalPayloadFromRequest, hashApprovalPayload, type ApprovalPayload } from '../executor/approval';
import { CARRIER_NAME } from '../core/carrier';

/** The word the operator types after the postal code to authorize the creation. */
export const CONFIRMATION_WORD = 'crear';

/** The accepted command-line flags. Anything else is refused. */
export const USAGE: readonly string[] = [
  'npm run ship -- --message <file>                          print the resolved payload and its approval hash, then stop (default)',
  'npm run ship -- --message <file> --approve <hash>         verify the hash, ask for the confirmation token, then create the shipment',
  'npm run ship -- --message <file> --approve <hash> --dry-run  verify the hash and walk the panel up to the summary, creating nothing',
  'npm run ship -- --help                                   show this text',
];

/** A refusal raised by a gate. Never a warning: the caller must stop. */
export class GateRefused extends Error {
  readonly details: readonly string[];

  constructor(message: string, details: readonly string[] = []) {
    super(message);
    this.name = 'GateRefused';
    this.details = details;
  }
}

/** One row of the printed payload: the panel field and the value that will be written. */
export interface PanelField {
  field: string;
  value: string;
}

/** Which journey an invocation asks for. */
export type RunMode = 'preview' | 'dry-run' | 'create';

export interface CliArgs {
  mode: RunMode;
  messagePath: string;
  /** The raw `--approve` value; validated later against the recomputed hash. */
  approve: string | null;
  /** True when `--dry-run` was passed explicitly. */
  dryRun: boolean;
  help: boolean;
}

/** Flags that would skip a gate. They are refused by name, not ignored. */
const BYPASS_FLAGS: readonly string[] = [
  '--yes',
  '-y',
  '--force',
  '-f',
  '--live',
  '--skip-approval',
  '--skip-confirmation',
  '--skip-gate',
  '--no-confirm',
  '--auto-confirm',
  '--assume-yes',
];

function takeValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('-')) {
    throw new GateRefused(`${flag} needs a value`, [
      `received: ${argv.join(' ') || '(no arguments)'}`,
      ...USAGE,
    ]);
  }
  return value;
}

/**
 * Parses the command line. Every malformed or gate-skipping shape is a hard
 * refusal that names the accepted flags; nothing is silently ignored.
 */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  let messagePath: string | null = null;
  let approve: string | null = null;
  let dryRun = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;

    if (BYPASS_FLAGS.includes(arg)) {
      throw new GateRefused(`refused: ${arg} is not supported`, [
        'the approval and the confirmation are the only ways to move past the gates',
        'there is no flag, environment variable or config switch that skips either of them',
        ...USAGE,
      ]);
    }

    switch (arg) {
      case '--help':
      case '-h':
        help = true;
        break;
      case '--message':
        if (messagePath !== null) throw new GateRefused('--message was given twice');
        messagePath = takeValue(argv, index, '--message');
        index += 1;
        break;
      case '--approve':
        if (approve !== null) throw new GateRefused('--approve was given twice');
        approve = takeValue(argv, index, '--approve');
        index += 1;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      default:
        if (arg.startsWith('-')) {
          throw new GateRefused(`unknown flag: ${arg}`, ['nothing was run', ...USAGE]);
        }
        throw new GateRefused(`unknown argument: ${arg}`, [
          'the only input is --message <file>; nothing was run',
          ...USAGE,
        ]);
    }
  }

  if (help) return { mode: 'preview', messagePath: messagePath ?? '', approve, dryRun, help };

  if (messagePath === null) {
    throw new GateRefused('missing --message <file>', USAGE);
  }

  const mode: RunMode = approve === null ? 'preview' : dryRun ? 'dry-run' : 'create';
  return { mode, messagePath, approve, dryRun, help };
}

/**
 * The approval artifact: sha-256 of the payload the operator saw, built from the
 * parsed request exactly as the preview prints it. The executor compares it with
 * the hash of the values read back from the panel, so the same canonical form
 * must be produced on both sides — hence `approval.ts`.
 */
export function computeApprovalHash(request: ShipmentRequest): string {
  return hashApprovalPayload(approvalPayloadFromRequest(request, CARRIER_NAME));
}

/** Every panel field of the resolved payload, in a stable order, for printing. */
export function describeApprovalPayload(payload: ApprovalPayload): PanelField[] {
  return [
    { field: 'zipCode', value: payload.zipCode },
    { field: 'box.height (cm)', value: payload.height },
    { field: 'box.width (cm)', value: payload.width },
    { field: 'box.depth (cm)', value: payload.depth },
    { field: 'box.weight (g)', value: payload.weight },
    { field: 'declaredValue', value: payload.declaredValue },
    { field: 'carrier', value: payload.carrier },
    { field: 'address.province (value)', value: payload.province.code },
    { field: 'address.province (text)', value: payload.province.name },
    { field: 'address.city', value: payload.city },
    { field: 'address.address', value: payload.address },
    { field: 'address.number', value: payload.number },
    { field: 'address.complement', value: payload.complement },
    { field: 'address.neighborhood', value: payload.neighborhood },
    { field: 'customer.name', value: payload.customer.name },
    { field: 'customer.lastName', value: payload.customer.lastName },
  ];
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Gate 1. Returns the normalized approval hash, or refuses.
 *
 * A missing hash is refused rather than treated as "the operator probably
 * approves": the first invocation is the artifact, and there is no run around it.
 */
export function assertApprovalHash(provided: string | null | undefined, expected: string): string {
  const approved = (expected ?? '').trim().toLowerCase();
  const raw = (provided ?? '').trim();

  if (raw === '') {
    throw new GateRefused('missing approval: this run needs the hash printed by the previous invocation', [
      'run again without --approve to print the resolved payload and its approval hash',
      'there is no flag, environment variable or config switch that stands in for that hash',
    ]);
  }

  const normalized = raw.toLowerCase();
  if (!HASH_PATTERN.test(normalized)) {
    throw new GateRefused('malformed approval hash', [
      `received: ${JSON.stringify(raw)}`,
      'expected: the 64-character lower-case sha-256 hex digest printed by the previous invocation',
      'nothing was run',
    ]);
  }

  if (normalized !== approved) {
    throw new GateRefused('approval refused: the payload no longer matches the approved hash', [
      `approved hash from --approve: ${normalized}`,
      `current payload hash:         ${approved}`,
      'the message changed between the two invocations, so the approval is invalid (by construction, not by policy)',
      'run again without --approve to see the new hash, re-read the payload, and approve that one',
    ]);
  }

  return normalized;
}

/** `"<postal code> crear"` — the exact text the operator must type before the click. */
export function confirmationTokenFor(request: ShipmentRequest): string {
  return `${request.zipCode} ${CONFIRMATION_WORD}`;
}

function normalizeToken(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Gate 2. Returns the accepted token, or refuses with nothing clicked. */
export function assertConfirmationToken(typed: string | null | undefined, expected: string): string {
  const wanted = normalizeToken(expected);
  const given = normalizeToken(typed ?? '');

  if (given === '') {
    throw new GateRefused('confirmation refused: no token was typed', [
      `expected exactly: ${JSON.stringify(expected)}`,
      'nothing was clicked and no shipment was created',
    ]);
  }

  if (given !== wanted) {
    throw new GateRefused('confirmation refused: the typed token does not match', [
      `typed:    ${JSON.stringify((typed ?? '').trim())}`,
      `expected: ${JSON.stringify(expected)}`,
      'nothing was clicked and no shipment was created',
    ]);
  }

  return expected;
}

/**
 * Fingerprint of the message text, used only to recognise "the same message"
 * across invocations (duplicate and unresolved-attempt checks). Line-ending and
 * trailing-whitespace churn is normalized away; every other byte counts.
 */
export function messageFingerprint(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n?/g, '\n').trimEnd(), 'utf8').digest('hex');
}

/** How a run's recorded outcome was classified. */
export type RunOutcomeStatus =
  /** The panel showed the detail page: the shipment exists. */
  | 'created'
  /** Clicked, but the detail page was never reached: only a human can decide. */
  | 'unknown'
  /** A human checked the shipment list and confirmed nothing was created. */
  | 'not-created';

/** A run record as the gate sees it, independent of where it is stored. */
export interface ExistingRun {
  runId: string;
  recordedAt: string;
  messageHash: string;
  approvalHash: string;
  confirmationToken: string;
  /** `null` when the run left no outcome: the process died, or it never clicked. */
  outcome: { status: RunOutcomeStatus; finishedAt: string; shipmentId: string | null } | null;
}

/**
 * Prior-attempt gate. Blocks a message that already has a run in an unresolved
 * state, because "run it again" is exactly how a second shipment gets created.
 *
 * Only a human clears one of these: by recording an outcome of `not-created`
 * (after checking the shipment list) or `created` (naming the shipment).
 */
export function assertNoBlockingPriorAttempt(records: readonly ExistingRun[], messageHash: string): void {
  const sameMessage = records.filter((record) => record.messageHash === messageHash);
  if (sameMessage.length === 0) return;

  for (const record of sameMessage) {
    const where = `run record ${record.runId} (recorded ${record.recordedAt})`;

    if (record.outcome === null) {
      throw new GateRefused('refused: a previous run for this message is attempted-unresolved', [
        `${where} was written before the create click and never recorded an outcome`,
        'the shipment may or may not exist, so this run is not retried automatically',
        'check the Envío Nube shipment list for this recipient by hand, then resolve the record as a human action',
        humanResolutionHint(record.runId),
      ]);
    }

    if (record.outcome.status === 'unknown') {
      throw new GateRefused('refused: a previous run for this message has an unknown outcome', [
        `${where} clicked the create button and never reached the shipment detail page`,
        `reconciliation recorded at ${record.outcome.finishedAt}`,
        'reconcile against the shipment list by hand and resolve the record; nothing is retried automatically',
        humanResolutionHint(record.runId),
      ]);
    }

    if (record.outcome.status === 'created') {
      throw new GateRefused(
        `refused: this message already created a shipment (${record.outcome.shipmentId ?? 'id not recorded'})`,
        [
          `${where} recorded the shipment ${record.outcome.shipmentId ?? '(id missing)'} as created`,
          'creating it again would duplicate the shipment, which is the failure this gate exists to prevent',
          'if a second shipment is genuinely intended, edit the message so it is a different payload',
        ],
      );
    }
  }
}

/** The exact hand-written resolution a human can use to close an open record. */
export function humanResolutionHint(runId: string): string {
  return `human resolution: write artifacts/run-records/${runId}.outcome.json with {"runId":"${runId}","finishedAt":"<ISO>","status":"not-created","shipmentId":null,"costShown":{"summaryModality":null,"detailShipmentData":null},"buyButtonVisible":false,"buyCardText":null,"reconciliation":null,"reportPath":"","recordedBy":"human"} (status "created" with the shipment id when one exists)`;
}

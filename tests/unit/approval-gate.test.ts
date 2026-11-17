/**
 * The two gates of the create path, tested as pure logic (R10, S10).
 *
 * Everything here is deterministic and offline: no panel, no browser, no
 * network, no file system. The data is fictional (R11).
 *
 * Gate 1 — approving the *data*: the operator re-runs with the hash of the
 *   payload that was printed. Any edit to the message in between changes the
 *   payload, so the earlier hash stops matching and the run refuses.
 * Gate 2 — authorizing the *creation*: immediately before the click the
 *   operator types an explicit token. Anything else aborts.
 *
 * There is no third path: no `--yes`, no `--force`, no environment variable,
 * no config flag.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { CARRIER_NAME } from '../../src/core/carrier';
import { parseMessage } from '../../src/core/parse-message';
import { approvalPayloadFromRequest } from '../../src/executor/approval';
import {
  CONFIRMATION_WORD,
  GateRefused,
  assertApprovalHash,
  assertConfirmationToken,
  assertNoBlockingPriorAttempt,
  computeApprovalHash,
  confirmationTokenFor,
  describeApprovalPayload,
  messageFingerprint,
  parseCliArgs,
  type ExistingRun,
} from '../../src/cli/gates';
import { HAPPY_MESSAGE, HAPPY_MESSAGE_CRLF } from './fixtures';

/** Fictional request parsed from the fictional fixture message. */
function fixtureRequest(message: string = HAPPY_MESSAGE) {
  const parsed = parseMessage(message);
  assert.ok(parsed.ok, 'the fixture message must parse');
  return parsed.value;
}

const REQUEST = fixtureRequest();
const APPROVAL_HASH = computeApprovalHash(REQUEST);

/** Fails the test unless the thrown value is a `GateRefused` whose text matches. */
function refusal(action: () => unknown, pattern: RegExp): GateRefused {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof GateRefused, `expected a GateRefused, received ${String(error)}`);
    const text = [error.message, ...error.details].join('\n');
    assert.match(text, pattern);
    return error;
  }
  assert.fail(`expected a refusal matching ${pattern}, but nothing was refused`);
}

// ---------------------------------------------------------------- gate 1: data

test('the approval hash is a 64-character sha-256 digest of the printed payload', () => {
  assert.match(APPROVAL_HASH, /^[0-9a-f]{64}$/);

  const payload = approvalPayloadFromRequest(REQUEST, CARRIER_NAME);
  assert.equal(APPROVAL_HASH, computeApprovalHash(REQUEST));
  assert.equal(describeApprovalPayload(payload).length, 16, 'every panel field is shown');
});

test('one edited character in the message produces a different approval hash', () => {
  const edited = fixtureRequest(HAPPY_MESSAGE.replace('Villa Ejemplo', 'Villa Ejemplx'));
  const editedHash = computeApprovalHash(edited);

  assert.notEqual(editedHash, APPROVAL_HASH);
  refusal(
    () => assertApprovalHash(APPROVAL_HASH, editedHash),
    /approval refused[\s\S]*changed[\s\S]*--approve/,
  );
});

test('a hash from any other payload is refused as a mismatch', () => {
  const other = fixtureRequest(HAPPY_MESSAGE.replace('1901', '1902'));
  refusal(() => assertApprovalHash(computeApprovalHash(other), APPROVAL_HASH), /approval refused/i);
});

test('the matching hash is accepted and normalized to lower case', () => {
  assert.equal(assertApprovalHash(`  ${APPROVAL_HASH.toUpperCase()}  `, APPROVAL_HASH), APPROVAL_HASH);
});

test('a missing approval hash is a hard refusal, never an implicit approval', () => {
  for (const missing of [null, undefined, '', '   ']) {
    refusal(() => assertApprovalHash(missing, APPROVAL_HASH), /missing approval[\s\S]*--approve/);
  }
});

test('a malformed approval hash is refused instead of being compared loosely', () => {
  refusal(() => assertApprovalHash('abc', APPROVAL_HASH), /malformed approval hash[\s\S]*64/);
  refusal(() => assertApprovalHash(`${'z'.repeat(64)}`, APPROVAL_HASH), /malformed approval hash/i);
  refusal(() => assertApprovalHash(`${APPROVAL_HASH.slice(0, 63)}`, APPROVAL_HASH), /malformed approval hash/i);
});

/** The payload rows, as the operator sees them. */
test('the printed payload carries every panel field with its value', () => {
  const payload = approvalPayloadFromRequest(REQUEST, CARRIER_NAME);
  const rows = new Map(describeApprovalPayload(payload).map((row) => [row.field, row.value]));

  assert.equal(rows.get('zipCode'), '1901');
  assert.equal(rows.get('box.weight (g)'), String(REQUEST.box.weightG));
  assert.equal(rows.get('carrier'), CARRIER_NAME);
  assert.equal(rows.get('address.province (value)'), REQUEST.address.province.code);
  assert.equal(rows.get('address.province (text)'), REQUEST.address.province.name);
  assert.equal(rows.get('address.city'), REQUEST.address.city);
  assert.equal(rows.get('address.neighborhood'), REQUEST.address.neighborhood);
  assert.equal(rows.get('customer.name'), REQUEST.customer.name);

  // Nothing may be blank except genuinely optional fields, and every value is a string.
  for (const [field, value] of rows) {
    assert.equal(typeof value, 'string', `${field} must print as text`);
  }
  assert.equal(rows.get('address.complement'), REQUEST.address.complement ?? '');
});

// ------------------------------------------------------- gate 2: the creation

test('the confirmation token is the destination postal code plus "crear"', () => {
  assert.equal(CONFIRMATION_WORD, 'crear');
  assert.equal(confirmationTokenFor(REQUEST), `${REQUEST.zipCode} crear`);
  assert.equal(confirmationTokenFor(REQUEST), '1901 crear');
});

test('the exact token is accepted, with whitespace and case normalized', () => {
  const expected = confirmationTokenFor(REQUEST);
  assert.equal(assertConfirmationToken('1901 crear', expected), expected);
  assert.equal(assertConfirmationToken('  1901    CREAR \n', expected), expected);
});

test('an empty or absent confirmation is refused, and nothing is clicked', () => {
  const expected = confirmationTokenFor(REQUEST);
  for (const missing of ['', '   ', '\n', null, undefined]) {
    refusal(() => assertConfirmationToken(missing, expected), /confirmation refused[\s\S]*nothing was clicked/);
  }
});

test('a wrong postal code or a missing word in the token is refused', () => {
  const expected = confirmationTokenFor(REQUEST);
  for (const wrong of ['1902 crear', '1901', 'crear', '1901crear', '1901 crear por favor', 'si']) {
    refusal(() => assertConfirmationToken(wrong, expected), /confirmation refused/i);
  }
});

// ------------------------------------------------------- prior attempts (S11)

function priorRun(patch: Partial<ExistingRun> = {}): ExistingRun {
  return {
    runId: '2026-01-01T00-00-00-000Z-aaaaaaaaaaaa',
    recordedAt: '2026-01-01T00:00:00.000Z',
    messageHash: messageFingerprint(HAPPY_MESSAGE),
    approvalHash: APPROVAL_HASH,
    confirmationToken: '1901 crear',
    outcome: null,
    ...patch,
  };
}

test('a prior attempt for the same message that never recorded an outcome blocks the run', () => {
  const messageHash = messageFingerprint(HAPPY_MESSAGE);
  refusal(
    () => assertNoBlockingPriorAttempt([priorRun()], messageHash),
    /attempted-unresolved[\s\S]*not retried automatically[\s\S]*human action/i,
  );
});

test('an unknown prior outcome blocks the run until a human reconciles it', () => {
  const messageHash = messageFingerprint(HAPPY_MESSAGE);
  refusal(
    () =>
      assertNoBlockingPriorAttempt(
        [
          priorRun({
            outcome: { status: 'unknown', finishedAt: '2026-01-01T00:05:00.000Z', shipmentId: null },
          }),
        ],
        messageHash,
      ),
    /unknown[\s\S]*reconcile/i,
  );
});

test('a prior run that already created a shipment is refused as a duplicate', () => {
  const messageHash = messageFingerprint(HAPPY_MESSAGE);
  refusal(
    () =>
      assertNoBlockingPriorAttempt(
        [
          priorRun({
            outcome: { status: 'created', finishedAt: '2026-01-01T00:05:00.000Z', shipmentId: '#EM1053' },
          }),
        ],
        messageHash,
      ),
    /#EM1053[\s\S]*duplicate|duplicate[\s\S]*#EM1053/i,
  );
});

test('a run for a different message is not blocked by another message\'s record', () => {
  const otherMessage = fixtureRequest(HAPPY_MESSAGE.replace('1901', '1902'));
  const otherHash = computeApprovalHash(otherMessage);
  assert.doesNotThrow(() =>
    assertNoBlockingPriorAttempt(
      [priorRun({ messageHash: messageFingerprint(HAPPY_MESSAGE.replace('1901', '1902')), approvalHash: otherHash })],
      messageFingerprint(HAPPY_MESSAGE),
    ),
  );
});

test('a human-resolved "nothing was created" outcome clears the way for a new attempt', () => {
  assert.doesNotThrow(() =>
    assertNoBlockingPriorAttempt(
      [
        priorRun({
          outcome: { status: 'not-created', finishedAt: '2026-01-01T00:05:00.000Z', shipmentId: null },
        }),
      ],
      messageFingerprint(HAPPY_MESSAGE),
    ),
  );
});

test('no records at all means no prior attempt', () => {
  assert.doesNotThrow(() => assertNoBlockingPriorAttempt([], messageFingerprint(HAPPY_MESSAGE)));
});

test('the message fingerprint ignores line-ending churn but not an edit', () => {
  const fingerprint = messageFingerprint(HAPPY_MESSAGE);
  assert.equal(messageFingerprint(HAPPY_MESSAGE_CRLF), fingerprint);
  assert.equal(messageFingerprint(`${HAPPY_MESSAGE}\n\n`), fingerprint);
  assert.equal(messageFingerprint(`${HAPPY_MESSAGE}   `), fingerprint);
  assert.notEqual(messageFingerprint(HAPPY_MESSAGE.replace('1901', '1902')), fingerprint);
  assert.notEqual(messageFingerprint(HAPPY_MESSAGE.replace('Villa Ejemplo', 'Villa  Ejemplo')), fingerprint);
});

// ---------------------------------------------------------- there is no bypass

test('the default invocation only previews: no approval, no creation', () => {
  const args = parseCliArgs(['--message', 'message.txt']);
  assert.equal(args.mode, 'preview');
  assert.equal(args.approve, null);
  assert.equal(args.messagePath, 'message.txt');
});

test('--approve selects the create path, and --dry-run keeps the non-creating path', () => {
  const create = parseCliArgs(['--message', 'message.txt', '--approve', APPROVAL_HASH]);
  assert.equal(create.mode, 'create');
  assert.equal(create.approve, APPROVAL_HASH);

  const dry = parseCliArgs(['--message', 'message.txt', '--approve', APPROVAL_HASH, '--dry-run']);
  assert.equal(dry.mode, 'dry-run');

  const dryWithoutApproval = parseCliArgs(['--message', 'message.txt', '--dry-run']);
  assert.equal(dryWithoutApproval.mode, 'preview');
});

test('every flag that would skip a gate is refused, not silently ignored', () => {
  const bypasses = [
    ['--message', 'message.txt', '--yes'],
    ['--message', 'message.txt', '-y'],
    ['--message', 'message.txt', '--force'],
    ['--message', 'message.txt', '--live'],
    ['--message', 'message.txt', '--skip-confirmation'],
    ['--message', 'message.txt', '--no-confirm'],
    ['--message', 'message.txt', '--auto-confirm', '1901 crear'],
    ['--message', 'message.txt', '--approve', APPROVAL_HASH, '--yes'],
  ];
  for (const argv of bypasses) {
    refusal(() => parseCliArgs(argv), /unknown flag|no flag|refused/i);
  }
});

test('malformed command lines are refused with the accepted flags listed', () => {
  refusal(() => parseCliArgs([]), /--message/i);
  refusal(() => parseCliArgs(['--message']), /--message[\s\S]*value/i);
  refusal(() => parseCliArgs(['--approve', APPROVAL_HASH]), /--message/i);
  refusal(() => parseCliArgs(['--message', 'a.txt', 'extra-positional']), /unknown argument|positional/i);
  refusal(() => parseCliArgs(['--message', 'a.txt', '--approve', APPROVAL_HASH, '--approve', APPROVAL_HASH]), /twice|duplicate/i);
});

test('--help is accepted and does nothing else', () => {
  const args = parseCliArgs(['--help']);
  assert.equal(args.help, true);
});

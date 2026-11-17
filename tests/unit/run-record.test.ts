/**
 * The durable run record (requirement 4 of the create path).
 *
 * The record is written **before** the create click, so a process that dies
 * mid-click still leaves the only trace of a possibly-created shipment. It is
 * append-only in shape: `<runId>.json` is the pre-click record,
 * `<runId>.outcome.json` is added only when an outcome is known. A record
 * without an outcome file is exactly what blocks the next run for the same
 * message hash.
 *
 * These tests use a throw-away temp directory and fictional data. No panel, no
 * browser, no network, and nothing inside the repository.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CARRIER_NAME } from '../../src/core/carrier';
import { parseMessage } from '../../src/core/parse-message';
import { approvalPayloadFromRequest } from '../../src/executor/approval';
import { GateRefused, assertNoBlockingPriorAttempt, computeApprovalHash, messageFingerprint } from '../../src/cli/gates';
import {
  attemptRecordPath,
  loadRunRecords,
  outcomeRecordPath,
  writeAttemptRecord,
  writeOutcomeRecord,
} from '../../src/cli/runRecord';
import { HAPPY_MESSAGE } from './fixtures';

const PARSED = parseMessage(HAPPY_MESSAGE);
assert.ok(PARSED.ok);
const REQUEST = PARSED.value;
const PAYLOAD = approvalPayloadFromRequest(REQUEST, CARRIER_NAME);

async function scratchDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'mdl-run-records-'));
}

async function seededRecord(dir: string, runId = 'run-1') {
  await writeAttemptRecord(dir, {
    runId,
    recordedAt: '2026-01-01T00:00:00.000Z',
    messageFile: 'message.txt',
    messageHash: messageFingerprint(HAPPY_MESSAGE),
    approvalHash: computeApprovalHash(REQUEST),
    payload: PAYLOAD,
    confirmation: { expected: '1901 crear', typed: '1901 crear' },
    status: 'attempted-unresolved',
    note: 'written before the create click',
  });
  return runId;
}

test('a written attempt record carries the timestamp, both hashes, the payload and the token', async () => {
  const dir = await scratchDir();
  const runId = await seededRecord(dir);

  assert.equal(attemptRecordPath(dir, runId), `${dir}/${runId}.json`);
  const records = await loadRunRecords(dir);

  assert.equal(records.length, 1);
  const [record] = records;
  assert.ok(record);
  assert.equal(record.runId, runId);
  assert.equal(record.recordedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(record.messageHash, messageFingerprint(HAPPY_MESSAGE));
  assert.equal(record.approvalHash, computeApprovalHash(REQUEST));
  assert.equal(record.confirmationToken, '1901 crear');
  assert.equal(record.outcome, null);

  const stored = JSON.parse(await (await import('node:fs/promises')).readFile(attemptRecordPath(dir, runId), 'utf8'));
  assert.deepEqual(stored.payload, PAYLOAD, 'the full approved payload is on disk, not just its hash');
  assert.equal(stored.status, 'attempted-unresolved');
});

test('an attempt without an outcome blocks a second run for the same message hash', async () => {
  const dir = await scratchDir();
  await seededRecord(dir);

  const records = await loadRunRecords(dir);
  assert.throws(
    () => assertNoBlockingPriorAttempt(records, messageFingerprint(HAPPY_MESSAGE)),
    (error: unknown) => error instanceof GateRefused,
  );
});

test('an outcome file is created next to the attempt and records the shipment id and cost', async () => {
  const dir = await scratchDir();
  const runId = await seededRecord(dir);

  await writeOutcomeRecord(dir, {
    runId,
    finishedAt: '2026-01-01T00:05:00.000Z',
    status: 'created',
    shipmentId: '#EM1053',
    costShown: { summaryModality: 'Andreani a domicilio — $ 8.500', detailShipmentData: 'Costo $ 8.500' },
    buyButtonVisible: true,
    buyCardText: 'El código de seguimiento se generará automáticamente al imprimir la etiqueta',
    reconciliation: null,
    reportPath: 'artifacts/executor-1/create-run.json',
    recordedBy: 'executor',
  });

  assert.equal(outcomeRecordPath(dir, runId), `${dir}/${runId}.outcome.json`);
  const [record] = await loadRunRecords(dir);
  assert.ok(record);
  assert.equal(record.outcome?.status, 'created');
  assert.equal(record.outcome?.shipmentId, '#EM1053');

  // A created shipment for the same message is a duplicate, not a fresh start.
  assert.throws(
    () => assertNoBlockingPriorAttempt([record], messageFingerprint(HAPPY_MESSAGE)),
    (error: unknown) => error instanceof GateRefused && /#EM1053/.test(error.message),
  );
});

test('a human-recorded "not-created" outcome clears the message hash', async () => {
  const dir = await scratchDir();
  const runId = await seededRecord(dir);
  await writeOutcomeRecord(dir, {
    runId,
    finishedAt: '2026-01-01T00:05:00.000Z',
    status: 'not-created',
    shipmentId: null,
    costShown: { summaryModality: null, detailShipmentData: null },
    buyButtonVisible: false,
    buyCardText: null,
    reconciliation: null,
    reportPath: '',
    recordedBy: 'human',
  });

  const records = await loadRunRecords(dir);
  assert.doesNotThrow(() => assertNoBlockingPriorAttempt(records, messageFingerprint(HAPPY_MESSAGE)));
});

test('a missing record directory means no prior attempts', async () => {
  const dir = path.join(await scratchDir(), 'does-not-exist');
  assert.deepEqual(await loadRunRecords(dir), []);
});

test('an unreadable record fails closed instead of disappearing from the gate', async () => {
  const dir = await scratchDir();
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'broken.json'), '{ this is not json', 'utf8');

  await assert.rejects(
    () => loadRunRecords(dir),
    (error: unknown) => error instanceof GateRefused && /could not be parsed/i.test(error.message),
  );
});

/**
 * R10 as amended: the `Crear envío` click is the only action that can create a
 * shipment, so an abort **before** it resolves itself as `not-created` instead
 * of leaving a blocking `attempted-unresolved` record for the operator ("si
 * quiero crear 10 pedidos igual debo poder hacerlos").
 *
 * What is asserted:
 *  - a pre-click abort writes the automatic `not-created` outcome
 *    (`recordedBy: 'executor'`, reason naming the stage), the pre-click record
 *    file still exists (crash visibility unchanged), and the next run for the
 *    same message proceeds;
 *  - a post-click unknown outcome still blocks: reconciliation stays manual;
 *  - a created outcome still blocks as a duplicate.
 *
 * Everything is offline and fictional (R11): temporary directories, invented
 * messages, an injected executor. No browser is opened; no panel is touched.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CARRIER_NAME } from '../../src/core/carrier';
import { parseMessage } from '../../src/core/parse-message';
import {
  GateRefused,
  assertNoBlockingPriorAttempt,
  computeApprovalHash,
  messageFingerprint,
} from '../../src/cli/gates';
import { attemptRecordPath, loadRunRecords, outcomeRecordPath, writeAttemptRecord, writeOutcomeRecord } from '../../src/cli/runRecord';
import { approvalPayloadFromRequest } from '../../src/executor/approval';
import { PreClickAbortError, UnknownOutcomeError } from '../../src/executor/errors';
import { analyzeMessage, runAttempt, type ActionDeps, type UiExecutor } from '../../src/ui/actions';
import { formValuesFromFields } from '../../src/ui/form';
import { HAPPY_MESSAGE } from './fixtures';

const REQUEST = (() => {
  const parsed = parseMessage(HAPPY_MESSAGE);
  assert.ok(parsed.ok, 'the fictional fixture must parse');
  return parsed.value;
})();

const EXPECTED_HASH = computeApprovalHash(REQUEST);
const MESSAGE_HASH = messageFingerprint(HAPPY_MESSAGE);

const PRE_CLICK_STAGE = 'journey to the summary (screens 1-4)';

// ------------------------------------------------------------- test doubles

function fixtureForm(): Record<string, string> {
  const analyzed = analyzeMessage(HAPPY_MESSAGE);
  assert.equal(analyzed.status, 'parsed');
  if (analyzed.status !== 'parsed') throw new Error('unreachable');
  return formValuesFromFields(analyzed.fields);
}

async function deps(executor: UiExecutor): Promise<ActionDeps> {
  return { executor, recordDir: await mkdtemp(path.join(tmpdir(), 'mdl-pre-click-')) };
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** The executor double: aborts before the click, exactly as the executor classifies it. */
function preClickExecutor(): UiExecutor {
  return {
    runDryRun: async () => {
      throw new Error('not used in these tests');
    },
    runCreate: async () => {
      throw new PreClickAbortError(
        PRE_CLICK_STAGE,
        'refusing to create the shipment: the panel does not hold the approved payload',
        ['zipCode: expected "1901", the panel holds "1902"'],
      );
    },
  };
}

/** The executor double: the click happened and the detail page never came. */
function unknownExecutor(): UiExecutor {
  return {
    runDryRun: async () => {
      throw new Error('not used in these tests');
    },
    runCreate: async () => {
      throw new UnknownOutcomeError('unknown outcome after clicking "Crear envío"', [
        'after one click on "Crear envío", no shipment detail page appeared',
      ]);
    },
  };
}

/** The executor double: the click happened and the shipment exists. */
function createdExecutor(): UiExecutor {
  return {
    runDryRun: async () => {
      throw new Error('not used in these tests');
    },
    runCreate: async () =>
      ({
        mode: 'create',
        modality: 'domicilio',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:01:00.000Z',
        approvedPayloadHash: EXPECTED_HASH,
        formPayloadHash: EXPECTED_HASH,
        mismatches: [],
        journey: {
          summary: { cards: [{ title: 'Modalidad de envío', text: `${CARRIER_NAME} · Costo $1234` }] },
        },
        outcome: 'created',
        shipment: {
          url: 'https://example.invalid/shipping-details/9999',
          shipmentId: '#EM9999',
          shipmentIdHeading: '#EM9999',
          statusBadges: ['Por enviar'],
          badgeTexts: ['Por enviar'],
          buyButtonVisible: true,
          buyCardText: 'El código de seguimiento se generará al imprimir la etiqueta',
          buttonNames: ['Imprimir'],
          bodyText: 'Envío creado con éxito',
          cards: [{ title: 'Datos del envío', present: true, text: `${CARRIER_NAME} · Costo $1234` }],
        },
        reconciliation: null,
        detailScreenshot: null,
        reportPath: 'artifacts/executor-fixture/create-run.json',
      }) as never,
  };
}

// ------------------------------------------------------------------ fixtures

async function seedCreatedRecord(dir: string, runId: string): Promise<void> {
  await writeAttemptRecord(dir, {
    runId,
    recordedAt: '2026-01-01T00:00:00.000Z',
    messageFile: '(pasted in the UI)',
    messageHash: MESSAGE_HASH,
    approvalHash: EXPECTED_HASH,
    payload: approvalPayloadFromRequest(REQUEST, CARRIER_NAME),
    status: 'attempted-unresolved',
    note: 'written before the click',
  });
  await writeOutcomeRecord(dir, {
    runId,
    finishedAt: '2026-01-01T00:01:00.000Z',
    status: 'created',
    shipmentId: '#EM1053',
    costShown: { summaryModality: null, detailShipmentData: null },
    buyButtonVisible: true,
    buyCardText: null,
    reconciliation: null,
    reportPath: '',
    recordedBy: 'executor',
  });
}

// ------------------------------------------------- 1. the automatic resolution

test('a pre-click abort auto-resolves as not-created and the next run for the same message proceeds', async () => {
  const d = await deps(preClickExecutor());

  try {
    const stopped = await runAttempt({ message: HAPPY_MESSAGE, form: fixtureForm(), mode: 'create' }, d);

    assert.equal(stopped.status, 'not-created');
    if (stopped.status !== 'not-created') return;
    assert.equal(stopped.stage, PRE_CLICK_STAGE, 'the stage the run reached is named');
    assert.match(stopped.reason, /does not hold the approved payload/);
    assert.match(stopped.note, /se puede repetir/, 'the operator is told the retry needs nothing');
    assert.doesNotMatch(stopped.note, /attempted-unresolved/, 'no resolve-the-record bureaucracy');

    // Crash visibility unchanged: the pre-click record file is still on disk.
    const record = JSON.parse(await readFile(stopped.recordPath, { encoding: 'utf8' })) as Record<string, unknown>;
    assert.equal(record['messageHash'], MESSAGE_HASH);
    assert.equal(record['status'], 'attempted-unresolved', 'the pre-click record keeps its written-before-the-click status');

    // The automatic outcome, written by the executor, with the stage as reason.
    const outcome = JSON.parse(await readFile(stopped.outcomePath, { encoding: 'utf8' })) as Record<string, unknown>;
    assert.equal(outcome['status'], 'not-created');
    assert.equal(outcome['recordedBy'], 'executor');
    assert.equal(outcome['shipmentId'], null);
    assert.match(
      String(outcome['reason']),
      new RegExp('aborted before the create click, at: ' + PRE_CLICK_STAGE.replaceAll('(', '\\(').replaceAll(')', '\\)')),
    );

    // The gate sees the resolved record: nothing blocks a retry.
    const records = await loadRunRecords(d.recordDir);
    assert.doesNotThrow(
      () => assertNoBlockingPriorAttempt(records, MESSAGE_HASH),
      'a not-created outcome never blocks the same message',
    );

    // End to end: the very next run for the same message creates the shipment.
    const next = await runAttempt({ message: HAPPY_MESSAGE, form: fixtureForm(), mode: 'create' }, {
      ...d,
      executor: createdExecutor(),
    });
    assert.equal(next.status, 'created', 'si quiero crear 10 pedidos igual debo poder hacerlos');
  } finally {
    await cleanup(d.recordDir);
  }
});

test('a post-click unknown outcome still blocks until a human reconciles it', async () => {
  const d = await deps(unknownExecutor());

  try {
    const stopped = await runAttempt({ message: HAPPY_MESSAGE, form: fixtureForm(), mode: 'create' }, d);

    assert.equal(stopped.status, 'unknown');
    if (stopped.status !== 'unknown') return;
    const outcome = JSON.parse(await readFile(stopped.outcomePath, { encoding: 'utf8' })) as Record<string, unknown>;
    assert.equal(outcome['status'], 'unknown');
    assert.equal(outcome['recordedBy'], 'executor');

    const records = await loadRunRecords(d.recordDir);
    assert.throws(
      () => assertNoBlockingPriorAttempt(records, MESSAGE_HASH),
      (error: unknown) => error instanceof GateRefused && /unknown outcome/.test(error.message),
      'the post-click contract is untouched: unknown stays a human decision',
    );

    const refused = await runAttempt({ message: HAPPY_MESSAGE, form: fixtureForm(), mode: 'create' }, d);
    assert.equal(refused.status, 'refused');
    if (refused.status !== 'refused') return;
    assert.equal(refused.stage, 'prior-attempt');
  } finally {
    await cleanup(d.recordDir);
  }
});

test('a created outcome still blocks as a duplicate', async () => {
  const d = await deps(createdExecutor());
  const runId = '2026-01-01T00-00-00-000Z-duplicateaaaa';

  try {
    await seedCreatedRecord(d.recordDir, runId);

    const refused = await runAttempt({ message: HAPPY_MESSAGE, form: fixtureForm(), mode: 'create' }, d);
    assert.equal(refused.status, 'refused');
    if (refused.status !== 'refused') return;
    assert.equal(refused.stage, 'prior-attempt');
    assert.match(refused.reason, /already created a shipment/i);
    assert.match(refused.details.join('\n'), /#EM1053/);
  } finally {
    await cleanup(d.recordDir);
  }
});

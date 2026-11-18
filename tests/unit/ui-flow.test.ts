/**
 * The two things the operator asked for, as tests.
 *
 * 1. **No native dialog.** The page and its script must never call `alert`,
 *    `confirm` or `prompt`. Every message — a rejection, a busy 409, a created
 *    shipment, an error — is rendered in the page itself. The previous revision
 *    put a `confirm(` in front of the creation, which is exactly what this
 *    asserts away.
 * 2. **No creation ceremony.** `POST /api/run` in create mode must work with the
 *    message, the values on screen and the mode, and nothing else: no approval
 *    hash to re-post, no typed token. That does **not** mean "create blindly" —
 *    the two refusals that prevent a duplicate shipment stay: an unresolved prior
 *    attempt for the same message, and a message that already created one.
 *
 * Everything is offline and fictional (R11): temporary directories, invented
 * messages, an injected executor. No browser is opened; no panel is touched.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { CARRIER_NAME } from '../../src/core/carrier';
import { computeApprovalHash, messageFingerprint } from '../../src/cli/gates';
import { parseMessage } from '../../src/core/parse-message';
import {
  attemptRecordPath,
  outcomeRecordPath,
  writeAttemptRecord,
} from '../../src/cli/runRecord';
import { approvalPayloadFromRequest } from '../../src/executor/approval';
import { analyzeMessage, type ActionDeps, type UiExecutor } from '../../src/ui/actions';
import { formValuesFromFields } from '../../src/ui/form';
import { APP_VERSION } from '../../src/ui/page';
import { HAPPY_MESSAGE } from './fixtures';

const REQUEST = (() => {
  const parsed = parseMessage(HAPPY_MESSAGE);
  assert.ok(parsed.ok, 'the fictional fixture must parse');
  return parsed.value;
})();

const PAYLOAD_HASH = computeApprovalHash(REQUEST);

// ------------------------------------------------------------------ fixtures

interface Box {
  root: string;
  recordDir: string;
}

async function box(name: string): Promise<Box> {
  const root = await mkdtemp(path.join(tmpdir(), `mdl-ui-flow-${name}-`));
  return { root, recordDir: path.join(root, 'run-records') };
}

async function cleanup(target: Box): Promise<void> {
  await rm(target.root, { recursive: true, force: true });
}

function fixtureForm(): Record<string, string> {
  const analyzed = analyzeMessage(HAPPY_MESSAGE);
  assert.equal(analyzed.status, 'parsed');
  if (analyzed.status !== 'parsed') throw new Error('unreachable');
  return formValuesFromFields(analyzed.fields);
}

/** The executor the page uses in production, with the browser replaced by a fixture. */
function fakeExecutor(): UiExecutor {
  return {
    runDryRun: async () => ({
      formMatchesApproval: true,
      mismatches: [],
      reportPath: 'artifacts/executor-fixture/dry-run.json',
    }) as never,
    runCreate: async () => ({
      outcome: 'created',
      finishedAt: '2026-01-01T00:01:00.000Z',
      reportPath: 'artifacts/executor-fixture/create-run.json',
      detailScreenshot: 'artifacts/executor-fixture/shipment-detail.png',
      journey: {
        summary: { cards: [{ title: 'Modalidad de envío', text: `${CARRIER_NAME} · Costo $1234` }] },
      },
      shipment: {
        url: 'https://example.invalid/shipping-details/9999',
        shipmentId: '#EM9999',
        shipmentIdHeading: '#EM9999',
        statusBadges: ['Por enviar', 'Envío manual'],
        badgeTexts: ['Por enviar', 'Envío manual'],
        // The label card is asserted for visibility and never clicked.
        buyButtonVisible: true,
        buyCardText: 'El código de seguimiento se generará al imprimir la etiqueta',
        buttonNames: ['Imprimir'],
        bodyText: 'Envío creado con éxito',
        cards: [{ title: 'Datos del envío', present: true, text: `${CARRIER_NAME} · Costo $1234` }],
      },
    }) as never,
  };
}

function deps(target: Box): ActionDeps {
  return { executor: fakeExecutor(), recordDir: target.recordDir };
}

function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ------------------------------------------------------- 1. no native dialog

test('neither the page nor the client script can open a native dialog', async () => {
  const { PAGE_HTML, CLIENT_JS } = await import('../../src/ui/server');

  for (const [name, source] of [
    ['the page', PAGE_HTML],
    ['the client script', CLIENT_JS],
  ] as const) {
    for (const call of ['alert(', 'confirm(', 'prompt(']) {
      assert.equal(
        source.includes(call),
        false,
        `${name} must not contain ${call} — every message is rendered inline`,
      );
    }
    // A `window.`-prefixed call would be the same dialog by another name.
    assert.equal(source.includes('window.'), false, `${name} must not reach through window`);
  }

  // The inline surfaces the messages actually go to exist in the markup.
  for (const id of ['analyze-status', 'run-status', 'result', 'rail-session-text', 'rail-errors-text']) {
    assert.match(PAGE_HTML, new RegExp(`id="${id}"`), `the page renders #${id}`);
  }
  // And they are announced, so a screen reader hears a rejection or a success.
  const liveRegions = PAGE_HTML.split('aria-live="polite"').length - 1;
  assert.ok(liveRegions >= 3, `the page carries at least three polite live regions, found ${liveRegions}`);
});

// --------------------------------------- 2. create without hash and without token

test('create mode works without an approval hash or a token, and records no confirmation', async () => {
  const target = await box('create');
  const { startUiServer } = await import('../../src/ui/server');
  const started = await startUiServer({ port: 0, deps: deps(target) });

  try {
    const analyzed = await post(`${started.url}/api/analyze`, { message: HAPPY_MESSAGE });
    assert.equal(analyzed.status, 200);
    const analysis = (await analyzed.json()) as { status: string; fields: never };
    assert.equal(analysis.status, 'parsed');
    const form = formValuesFromFields(analysis.fields);

    // The whole request: message, the values on screen, mode. Nothing else.
    const created = await post(`${started.url}/api/run`, { message: HAPPY_MESSAGE, form, mode: 'create' });
    assert.equal(created.status, 200);
    const body = (await created.json()) as { status: string; shipmentId: string; recordPath: string };
    assert.equal(body.status, 'created', 'no ceremony stands between the click and the shipment');
    assert.equal(body.shipmentId, '#EM9999');

    // The pre-click record exists, and it carries no typed confirmation: there is
    // no token on this surface to record.
    const record = JSON.parse(await readFile(body.recordPath, { encoding: 'utf8' })) as Record<string, unknown>;
    assert.equal(record['messageHash'], messageFingerprint(HAPPY_MESSAGE));
    assert.equal(record['approvalHash'], PAYLOAD_HASH, 'the payload hash is the server-computed one');
    assert.equal('confirmation' in record, false, 'the UI path has no token to record');
    assert.equal(record['status'], 'attempted-unresolved');
  } finally {
    await started.close();
    await cleanup(target);
  }
});

// ------------------------------------------------- 3. the duplicate refusals stay

test('a message that already created a shipment is still refused, with nothing created twice', async () => {
  const target = await box('duplicate');
  const { startUiServer } = await import('../../src/ui/server');
  const started = await startUiServer({ port: 0, deps: deps(target) });
  const runId = '2026-01-01T00-00-00-000Z-duplicateaaaa';

  try {
    await writeAttemptRecord(target.recordDir, {
      runId,
      recordedAt: '2026-01-01T00:00:00.000Z',
      messageFile: '(pasted in the UI)',
      messageHash: messageFingerprint(HAPPY_MESSAGE),
      approvalHash: PAYLOAD_HASH,
      payload: approvalPayloadFromRequest(REQUEST, CARRIER_NAME),
      status: 'attempted-unresolved',
      note: 'written before the click',
    });
    await writeFile(
      outcomeRecordPath(target.recordDir, runId),
      `${JSON.stringify({
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
      })}\n`,
      { encoding: 'utf8' },
    );

    const response = await post(`${started.url}/api/run`, {
      message: HAPPY_MESSAGE,
      form: fixtureForm(),
      mode: 'create',
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { status: string; stage: string; reason: string; details: string[] };
    assert.equal(body.status, 'refused');
    assert.equal(body.stage, 'prior-attempt');
    assert.match(body.reason, /already created a shipment/i);
    assert.match(body.details.join('\n'), /#EM1053/, 'the existing shipment is named');

    // Nothing new was written: the only files are the seeded pair.
    const entries = await readdir(target.recordDir);
    assert.deepEqual(entries.sort(), [`${runId}.json`, `${runId}.outcome.json`].sort());
  } finally {
    await started.close();
    await cleanup(target);
  }
});

test('an unresolved prior attempt for the same message is still refused', async () => {
  const target = await box('unresolved');
  const { startUiServer } = await import('../../src/ui/server');
  const started = await startUiServer({ port: 0, deps: deps(target) });
  const runId = '2026-01-01T00-00-00-000Z-unresolvedaa';

  try {
    await writeAttemptRecord(target.recordDir, {
      runId,
      recordedAt: '2026-01-01T00:00:00.000Z',
      messageFile: '(pasted in the UI)',
      messageHash: messageFingerprint(HAPPY_MESSAGE),
      approvalHash: PAYLOAD_HASH,
      payload: approvalPayloadFromRequest(REQUEST, CARRIER_NAME),
      status: 'attempted-unresolved',
      note: 'written before the click',
    });

    const response = await post(`${started.url}/api/run`, {
      message: HAPPY_MESSAGE,
      form: fixtureForm(),
      mode: 'create',
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { status: string; stage: string; details: string[] };
    assert.equal(body.status, 'refused');
    assert.equal(body.stage, 'prior-attempt');
    assert.match(body.details.join('\n'), /\.outcome\.json/, 'the operator is told which record to resolve');
    assert.equal(
      (await readdir(target.recordDir)).includes(`${runId}.outcome.json`),
      false,
      'no outcome is invented for the open record',
    );
  } finally {
    await started.close();
    await cleanup(target);
  }
});

// ----------------------------------------------- 4. the dry run has no side effects

test('a dry run walks the panel and writes no record at all', async () => {
  const target = await box('dry-run');
  const { startUiServer } = await import('../../src/ui/server');
  const started = await startUiServer({ port: 0, deps: deps(target) });

  try {
    const response = await post(`${started.url}/api/run`, {
      message: HAPPY_MESSAGE,
      form: fixtureForm(),
      mode: 'dry-run',
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { status: string; payloadHash: string };
    assert.equal(body.status, 'dry-run');
    assert.equal(body.payloadHash, PAYLOAD_HASH);

    const entries = await readdir(target.recordDir).catch(() => [] as string[]);
    assert.deepEqual(entries, [], 'the dry run writes nothing to the run-record directory');
    assert.equal(
      path.basename(target.recordDir),
      'run-records',
      'this is the directory the creation path writes to, so an empty one is the proof',
    );
    // Naming the path it would have written makes the assertion above explicit.
    assert.equal(attemptRecordPath(target.recordDir, 'x').endsWith('x.json'), true);
  } finally {
    await started.close();
    await cleanup(target);
  }
});

// -------------------------------------------------------------- 5. the footer

test('the version the rail prints is the package version', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), { encoding: 'utf8' }),
  ) as { version: string };
  assert.equal(APP_VERSION, manifest.version, 'the rail footer must not drift from package.json');
});

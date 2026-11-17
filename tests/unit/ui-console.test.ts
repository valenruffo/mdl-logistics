/**
 * The local UI's server logic (one page: paste, preview, approve, run).
 *
 * Everything here is offline and fictional (R11): no browser, no panel, no
 * network beyond a loopback socket. The two gates and the run record are the
 * existing ones from `src/cli/` — these tests pin that the UI *reuses* them
 * instead of growing its own.
 *
 * What is asserted:
 *  - a rejected message renders missing / invalid / unknown labels with reasons
 *    and leaves nothing actionable;
 *  - the approval hash is recomputed **server-side** from the current form
 *    values, so editing a field after approval invalidates the approval;
 *  - approving the data never authorizes the creation: the token gate is
 *    separate and a wrong or absent token creates nothing;
 *  - an unresolved prior attempt for the same message refuses the creation
 *    (reusing `assertNoBlockingPriorAttempt`);
 *  - executor failures surface verbatim, details included;
 *  - there is no route, handler or served byte that offers a purchase.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CARRIER_NAME } from '../../src/core/carrier';
import { parseMessage } from '../../src/core/parse-message';
import { computeApprovalHash, messageFingerprint } from '../../src/cli/gates';
import { attemptRecordPath, outcomeRecordPath, writeAttemptRecord } from '../../src/cli/runRecord';
import { approvalPayloadFromRequest } from '../../src/executor/approval';
import { ExecutorError } from '../../src/executor/errors';
import {
  analyzeMessage,
  approveForm,
  runAttempt,
  type ActionDeps,
  type UiExecutor,
} from '../../src/ui/actions';
import { formValuesFromFields } from '../../src/ui/form';
import { HAPPY_MESSAGE, withLines, withoutLine } from './fixtures';

const REQUEST = (() => {
  const parsed = parseMessage(HAPPY_MESSAGE);
  assert.ok(parsed.ok, 'the fictional fixture must parse');
  return parsed.value;
})();

const EXPECTED_HASH = computeApprovalHash(REQUEST);
const TOKEN = '1901 crear';

// --------------------------------------------------------------- test doubles

function costUnits() {
  return { height: 'cm', width: 'cm', depth: 'cm', weight: 'g' };
}

function journeyFixture() {
  return {
    cost: {
      zipCode: '1901',
      height: '20',
      width: '25',
      depth: '10',
      weight: '700',
      declaredValue: '',
      units: costUnits(),
    },
    carrier: { selectedName: CARRIER_NAME, checked: true, options: [CARRIER_NAME] },
    recipient: {
      province: { value: 'C', text: 'Ciudad Autónoma de Buenos Aires' },
      city: 'Villa Ejemplo',
      address: 'Calle Falsa',
      number: '742',
      complement: '2b',
      neighborhood: 'Villa Ejemplo',
      name: 'Juan',
      lastName: 'Perez',
    },
    summary: {
      url: 'https://example.invalid/create-single-shipment/review',
      heading: 'Resumen del envío',
      stepBadge: 'Paso 4 de 4',
      cards: [
        { title: 'Datos para envío', present: true, text: 'Destino: Calle Falsa 742' },
        { title: 'Modalidad de envío', present: true, text: 'Andreani a domicilio · $1234' },
        { title: 'Datos del destinatario', present: true, text: 'Juan Perez' },
      ],
      createButtonVisible: true,
      bodyText: 'Resumen del envío',
    },
  };
}

function dryRunFixture(patch: Record<string, unknown> = {}) {
  return {
    mode: 'dry-run',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
    approvedPayloadHash: EXPECTED_HASH,
    formPayloadHash: EXPECTED_HASH,
    formMatchesApproval: true,
    mismatches: [],
    journey: journeyFixture(),
    stoppedAt: 'summary',
    createButtonPresent: true,
    reportPath: 'artifacts/executor-fixture/dry-run.json',
    ...patch,
  };
}

function createdFixture(patch: Record<string, unknown> = {}) {
  const shipment = {
    url: 'https://example.invalid/shipping-details/9999',
    shipmentId: '#EM9999',
    shipmentIdHeading: '#EM9999',
    statusBadges: ['Por enviar', 'Envío manual'],
    badgeTexts: ['Por enviar', 'Envío manual'],
    cards: [
      { title: 'Comprar etiqueta', present: true, text: 'El código de seguimiento se generará al imprimir la etiqueta' },
      { title: 'Datos del envío', present: true, text: 'Andreani a domicilio · Costo $1234' },
    ],
    buyCardText: 'El código de seguimiento se generará al imprimir la etiqueta',
    buttonNames: ['Comprar etiqueta', 'Imprimir'],
    buyButtonVisible: true,
    bodyText: 'Envío creado con éxito',
  };
  return {
    mode: 'create',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
    approvedPayloadHash: EXPECTED_HASH,
    formPayloadHash: EXPECTED_HASH,
    mismatches: [],
    journey: journeyFixture(),
    detailScreenshot: 'artifacts/executor-fixture/shipment-detail.png',
    reportPath: 'artifacts/executor-fixture/create-run.json',
    outcome: 'created',
    shipment,
    reconciliation: null,
    ...patch,
  };
}

interface FakeExecutor {
  executor: UiExecutor;
  calls: { kind: 'dry-run' | 'create'; approvedPayloadHash: string }[];
}

function fakeExecutor(overrides: Partial<UiExecutor> = {}): FakeExecutor {
  const calls: FakeExecutor['calls'] = [];
  const executor: UiExecutor = {
    runDryRun: async (input) => {
      calls.push({ kind: 'dry-run', approvedPayloadHash: input.approvedPayloadHash });
      return dryRunFixture() as never;
    },
    runCreate: async (input) => {
      calls.push({ kind: 'create', approvedPayloadHash: input.approvedPayloadHash });
      return createdFixture() as never;
    },
    ...overrides,
  };
  return { executor, calls };
}

async function deps(executor: UiExecutor): Promise<ActionDeps> {
  return { executor, recordDir: await mkdtemp(path.join(tmpdir(), 'mdl-ui-records-')) };
}

/** The form values the preview would show for the fictional fixture message. */
function fixtureForm(): Record<string, string> {
  const analyzed = analyzeMessage(HAPPY_MESSAGE);
  assert.equal(analyzed.status, 'parsed');
  if (analyzed.status !== 'parsed') throw new Error('unreachable');
  return formValuesFromFields(analyzed.fields);
}

// ------------------------------------------------------------------ 1. analyze

test('a message the parser rejects renders every reason and leaves nothing actionable', () => {
  const broken = withLines(
    withoutLine(HAPPY_MESSAGE, 'Código postal'),
    ['Teléfono: 555 0000'],
  ).replace('Provincia: Ciudad Autónoma de Buenos Aires (CABA)', 'Provincia: Bs As');

  const analyzed = analyzeMessage(broken);
  assert.equal(analyzed.status, 'rejected');
  if (analyzed.status !== 'rejected') return;

  const missing = analyzed.missing.map((item) => item.label);
  assert.deepEqual(missing, ['Código postal'], 'the missing field is named by its message label');
  for (const item of analyzed.missing) {
    assert.ok(item.reason.length > 0, `missing ${item.label} carries a reason`);
    assert.match(item.reason, /Código postal/);
  }

  assert.equal(analyzed.invalid.length, 1);
  const [invalid] = analyzed.invalid;
  assert.ok(invalid);
  assert.equal(invalid.field, 'province');
  assert.match(invalid.reason, /ambiguous/i, 'the reason is the parser\'s own, verbatim');
  assert.match(invalid.value, /Bs As/);

  assert.deepEqual(analyzed.unknownLabels, ['Teléfono']);

  // Nothing to approve, nothing to run: the rejection response has no form.
  assert.equal('fields' in analyzed, false);
  assert.equal('provinces' in analyzed, false);
});

test('a parsed message prefills every panel field and marks the derived ones', () => {
  const analyzed = analyzeMessage(withoutLine(HAPPY_MESSAGE, 'Barrio'));
  assert.equal(analyzed.status, 'parsed');
  if (analyzed.status !== 'parsed') return;

  const keys = analyzed.fields.map((field) => field.key);
  assert.deepEqual(keys, [
    'zipCode',
    'province',
    'city',
    'address',
    'number',
    'complement',
    'neighborhood',
    'name',
    'lastName',
    'height',
    'width',
    'depth',
    'weight',
    'declaredValue',
  ]);

  const byKey = new Map(analyzed.fields.map((field) => [field.key, field]));
  assert.equal(byKey.get('zipCode')?.value, '1901');
  assert.equal(byKey.get('province')?.value, 'Ciudad Autónoma de Buenos Aires');
  assert.equal(byKey.get('name')?.value, 'Juan');
  assert.equal(byKey.get('lastName')?.value, 'Perez');
  assert.equal(byKey.get('weight')?.value, '700');
  assert.equal(byKey.get('weight')?.unit, 'g', 'the panel reads grams, so the form says grams');
  assert.equal(byKey.get('height')?.unit, 'cm');

  const neighborhood = byKey.get('neighborhood');
  assert.ok(neighborhood, 'Barrio is part of the form');
  assert.ok(
    neighborhood.derived.some((derivation) => derivation.rule === 'neighborhood-from-city'),
    'a Barrio filled from Ciudad is marked as derived',
  );
  assert.ok(byKey.get('lastName')?.derived.some((rule) => rule.rule === 'full-name-split'));

  // The operator's province choices come from the panel's own option list.
  assert.equal(analyzed.provinces.length, 25);
  assert.ok(analyzed.provinces.some((option) => option.code === 'BX' && option.name === 'Gran Buenos Aires'));
});

test('a non-blocking warning travels to the preview instead of blocking the message', () => {
  const analyzed = analyzeMessage(HAPPY_MESSAGE.replace('Barrio: Villa Ejemplo', 'Barrio: Otro Barrio'));
  assert.equal(analyzed.status, 'parsed');
  if (analyzed.status !== 'parsed') return;
  assert.equal(analyzed.warnings.length, 1);
  assert.match(analyzed.warnings[0]?.message ?? '', /differs from/i);
});

// ------------------------------------------------------------------ 2. approve

test('approving recomputes the canonical hash server-side from the posted values', async () => {
  const { executor } = fakeExecutor();
  const form = fixtureForm();
  const approved = await approveForm({ message: HAPPY_MESSAGE, form }, await deps(executor));

  assert.equal(approved.status, 'approved');
  if (approved.status !== 'approved') return;
  assert.equal(approved.approvalHash, EXPECTED_HASH, 'the hash is the one the executor will compare against');
  assert.equal(approved.payload.length, 16, 'every panel field is shown for approval');
  assert.ok(approved.payload.some((row) => row.field === 'box.weight (g)' && row.value === '700'));
  assert.ok(approved.payload.some((row) => row.field === 'carrier' && row.value === CARRIER_NAME));
});

test('one edited field after approval produces a different hash and the run refuses', async () => {
  const fake = fakeExecutor();
  const d = await deps(fake.executor);
  const form = fixtureForm();

  const approved = await approveForm({ message: HAPPY_MESSAGE, form }, d);
  assert.equal(approved.status, 'approved');
  if (approved.status !== 'approved') return;

  const edited = { ...form, city: 'Villa Ejemplx' };
  const refused = await runAttempt(
    { message: HAPPY_MESSAGE, form: edited, mode: 'create', approvedHash: approved.approvalHash, token: TOKEN },
    d,
  );

  assert.equal(refused.status, 'refused');
  if (refused.status !== 'refused') return;
  assert.equal(refused.stage, 'approval');
  assert.match(refused.reason, /approval refused/i);
  assert.match(refused.details.join('\n'), /current payload hash/);
  assert.equal(fake.calls.length, 0, 'nothing reached the executor');

  // Re-approving the edited values yields a different hash, and that hash passes.
  const reapproved = await approveForm({ message: HAPPY_MESSAGE, form: edited }, d);
  assert.equal(reapproved.status, 'approved');
  if (reapproved.status !== 'approved') return;
  assert.notEqual(reapproved.approvalHash, approved.approvalHash);

  const pastGate = await runAttempt(
    { message: HAPPY_MESSAGE, form: edited, mode: 'create', approvedHash: reapproved.approvalHash, token: '' },
    d,
  );
  assert.equal(pastGate.status, 'refused');
  if (pastGate.status !== 'refused') return;
  assert.equal(pastGate.stage, 'confirmation', 'the approval gate let it through; the token gate stopped it');
});

test('an edited value the panel could not hold is an invalid form, not a run', async () => {
  const fake = fakeExecutor();
  const d = await deps(fake.executor);
  const form = fixtureForm();

  const approved = await approveForm({ message: HAPPY_MESSAGE, form: { ...form, weight: '0' } }, d);
  assert.equal(approved.status, 'invalid-form');
  if (approved.status !== 'invalid-form') return;
  assert.equal(approved.errors[0]?.field, 'weight');
  assert.match(approved.errors[0]?.message ?? '', /positivo|positive/i);

  const badZip = await approveForm({ message: HAPPY_MESSAGE, form: { ...form, zipCode: '12' } }, d);
  assert.equal(badZip.status, 'invalid-form');

  const badProvince = await approveForm({ message: HAPPY_MESSAGE, form: { ...form, province: 'Bs As' } }, d);
  assert.equal(badProvince.status, 'invalid-form');
  if (badProvince.status !== 'invalid-form') return;
  assert.match(badProvince.errors[0]?.message ?? '', /ambiguous/i, 'the province reason is the parser\'s own');

  const emptyName = await approveForm({ message: HAPPY_MESSAGE, form: { ...form, name: '   ' } }, d);
  assert.equal(emptyName.status, 'invalid-form');

  assert.equal(fake.calls.length, 0);
});

// ------------------------------------------------------ 3. the two gates apart

test('approving the data does not authorize the creation: no token means no run', async () => {
  const fake = fakeExecutor();
  const d = await deps(fake.executor);
  const form = fixtureForm();

  const refused = await runAttempt(
    { message: HAPPY_MESSAGE, form, mode: 'create', approvedHash: EXPECTED_HASH, token: '' },
    d,
  );

  assert.equal(refused.status, 'refused');
  if (refused.status !== 'refused') return;
  assert.equal(refused.stage, 'confirmation');
  assert.match(refused.reason, /confirmation refused/i);
  assert.match(refused.details.join('\n'), /1901 crear/);
  assert.equal(fake.calls.length, 0, 'nothing was clicked and nothing was created');
});

test('a token that does not match the destination is refused, with nothing created', async () => {
  const fake = fakeExecutor();
  const d = await deps(fake.executor);
  const form = fixtureForm();

  for (const token of ['1902 crear', '1901', 'crear', '1901 crear por favor']) {
    const refused = await runAttempt(
      { message: HAPPY_MESSAGE, form, mode: 'create', approvedHash: EXPECTED_HASH, token },
      d,
    );
    assert.equal(refused.status, 'refused', `token ${JSON.stringify(token)} must be refused`);
    if (refused.status !== 'refused') continue;
    assert.equal(refused.stage, 'confirmation');
    assert.match(refused.details.join('\n'), /typed/);
  }
  assert.equal(fake.calls.length, 0);
});

// ------------------------------------------------------------ 4. prior attempts

test('an unresolved prior attempt for the same message refuses the creation', async () => {
  const fake = fakeExecutor();
  const d = await deps(fake.executor);
  const form = fixtureForm();

  await writeAttemptRecord(d.recordDir, {
    runId: '2026-01-01T00-00-00-000Z-aaaaaaaaaaaa',
    recordedAt: '2026-01-01T00:00:00.000Z',
    messageFile: '(pasted in the UI)',
    messageHash: messageFingerprint(HAPPY_MESSAGE),
    approvalHash: EXPECTED_HASH,
    payload: approvalPayloadFromRequest(REQUEST, CARRIER_NAME),
    confirmation: { expected: TOKEN, typed: TOKEN },
    status: 'attempted-unresolved',
    note: 'written before the click',
  });

  const refused = await runAttempt(
    { message: HAPPY_MESSAGE, form, mode: 'create', approvedHash: EXPECTED_HASH, token: TOKEN },
    d,
  );

  assert.equal(refused.status, 'refused');
  if (refused.status !== 'refused') return;
  assert.equal(refused.stage, 'prior-attempt');
  assert.match(refused.reason, /attempted-unresolved|already created|unknown outcome/i);
  assert.match(refused.details.join('\n'), /\.outcome\.json/, 'the operator is told which record to resolve');
  assert.equal(fake.calls.length, 0, 'the panel is never driven for an unresolved message');
});

test('the same unresolved record does not block a dry run, which creates nothing', async () => {
  const fake = fakeExecutor();
  const d = await deps(fake.executor);

  await writeAttemptRecord(d.recordDir, {
    runId: '2026-01-01T00-00-00-000Z-bbbbbbbbbbbb',
    recordedAt: '2026-01-01T00:00:00.000Z',
    messageFile: '(pasted in the UI)',
    messageHash: messageFingerprint(HAPPY_MESSAGE),
    approvalHash: EXPECTED_HASH,
    payload: approvalPayloadFromRequest(REQUEST, CARRIER_NAME),
    confirmation: { expected: TOKEN, typed: TOKEN },
    status: 'attempted-unresolved',
    note: 'written before the click',
  });

  const result = await runAttempt(
    { message: HAPPY_MESSAGE, form: fixtureForm(), mode: 'dry-run', approvedHash: EXPECTED_HASH, token: null },
    d,
  );

  assert.equal(result.status, 'dry-run');
  if (result.status !== 'dry-run') return;
  assert.ok(result.note !== null, 'the open prior attempt is still reported to the operator');
  assert.match(result.note ?? '', /1 earlier run/);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]?.kind, 'dry-run');
});

// --------------------------------------------------------------- 5. the outcome

test('the dry run stops on the summary and reports the panel diff', async () => {
  const fake = fakeExecutor();
  const d = await deps(fake.executor);

  const result = await runAttempt(
    { message: HAPPY_MESSAGE, form: fixtureForm(), mode: 'dry-run', approvedHash: EXPECTED_HASH, token: null },
    d,
  );

  assert.equal(result.status, 'dry-run');
  if (result.status !== 'dry-run') return;
  assert.equal(result.summaryReached, true);
  assert.equal(result.formMatchesApproval, true);
  assert.deepEqual(result.mismatches, []);
  assert.match(result.approvedHash, /^[0-9a-f]{64}$/);
  assert.match(result.currentHash, /^[0-9a-f]{64}$/);
  assert.equal(result.approvedHash, result.currentHash);
  assert.equal(result.reportPath, 'artifacts/executor-fixture/dry-run.json');
});

test('a created shipment reports the id, the cost and the structural unpaid-label proof', async () => {
  const fake = fakeExecutor();
  const d = await deps(fake.executor);

  const result = await runAttempt(
    { message: HAPPY_MESSAGE, form: fixtureForm(), mode: 'create', approvedHash: EXPECTED_HASH, token: TOKEN },
    d,
  );

  assert.equal(result.status, 'created');
  if (result.status !== 'created') return;

  assert.equal(result.shipmentId, '#EM9999');
  assert.deepEqual(result.statusBadges, ['Por enviar', 'Envío manual']);
  assert.match(result.cost.summary ?? '', /1234/);
  assert.match(result.cost.detail ?? '', /1234/);
  assert.equal(result.labelUnpaid.proven, true);
  assert.equal(result.labelUnpaid.problem, null);
  assert.deepEqual(result.labelUnpaid.details, []);

  // Both halves of the durable record exist, and the outcome says "created".
  assert.ok(existsSync(result.recordPath), `the pre-click record is on disk: ${result.recordPath}`);
  assert.ok(existsSync(result.outcomePath), `the outcome record is on disk: ${result.outcomePath}`);
  const outcome = JSON.parse(readFileSync(result.outcomePath, 'utf8'));
  assert.equal(outcome.status, 'created');
  assert.equal(outcome.shipmentId, '#EM9999');

  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]?.approvedPayloadHash, EXPECTED_HASH);
});

test('an executor failure is surfaced verbatim, details included, and names the open record', async () => {
  const failure = new ExecutorError('the label is not proven unpaid', [
    'shipmentId: the heading read "#EM9999"',
    'statusBadge: the badge text read ["En camino"]',
    'screenshot captured: artifacts/executor-fixture/failure.png',
  ]);
  const fake = fakeExecutor({
    runCreate: async () => {
      throw failure;
    },
  });
  const d = await deps(fake.executor);

  const result = await runAttempt(
    { message: HAPPY_MESSAGE, form: fixtureForm(), mode: 'create', approvedHash: EXPECTED_HASH, token: TOKEN },
    d,
  );

  assert.equal(result.status, 'failed');
  if (result.status !== 'failed') return;
  assert.equal(result.reason, 'ExecutorError: the label is not proven unpaid');
  assert.match(result.details.join('\n'), /badge text read \["En camino"\]/, 'the real reason is not summarized away');
  assert.match(result.details.join('\n'), /failure\.png/);
  assert.ok(result.recordPath !== null);
  assert.ok(existsSync(result.recordPath), 'the attempt record stays on disk, unresolved');
  assert.equal(
    existsSync(outcomeRecordPath(d.recordDir, path.basename(result.recordPath, '.json'))),
    false,
    'no outcome is invented for a failed run',
  );
  assert.match(result.note ?? '', /attempted-unresolved/);
});

test('an unknown creation outcome reports the reconciliation and the record to inspect', async () => {
  const fake = fakeExecutor({
    runCreate: async () =>
      createdFixture({
        outcome: 'unknown',
        shipment: null,
        reconciliation: {
          dashboardUrl: 'https://example.invalid/#/dashboard',
          frameUrl: null,
          searchedFor: { zipCode: '1901', recipientName: 'Juan Perez' },
          matches: ['#EM9999 · Por enviar · 1901'],
          bodyText: '',
          method: 'read-only list scan',
          interpretation: 'one candidate row matches the recipient and postal code',
        },
      }) as never,
  });
  const d = await deps(fake.executor);

  const result = await runAttempt(
    { message: HAPPY_MESSAGE, form: fixtureForm(), mode: 'create', approvedHash: EXPECTED_HASH, token: TOKEN },
    d,
  );

  assert.equal(result.status, 'unknown');
  if (result.status !== 'unknown') return;
  assert.deepEqual(result.matches, ['#EM9999 · Por enviar · 1901']);
  assert.match(result.interpretation, /one candidate row/i);
  assert.ok(existsSync(result.recordPath));
  const outcome = JSON.parse(readFileSync(result.outcomePath, 'utf8'));
  assert.equal(outcome.status, 'unknown');
});

test('the approval hash the client sends is never trusted: the run recomputes it', async () => {
  const fake = fakeExecutor();
  const d = await deps(fake.executor);

  // A hash forged by the client (any other payload's hash) is refused by gate 1.
  const forged = 'f'.repeat(64);
  const refused = await runAttempt(
    { message: HAPPY_MESSAGE, form: fixtureForm(), mode: 'create', approvedHash: forged, token: TOKEN },
    d,
  );
  assert.equal(refused.status, 'refused');
  if (refused.status !== 'refused') return;
  assert.equal(refused.stage, 'approval');
  assert.equal(fake.calls.length, 0);

  const missing = await runAttempt(
    { message: HAPPY_MESSAGE, form: fixtureForm(), mode: 'create', approvedHash: null, token: TOKEN },
    d,
  );
  assert.equal(missing.status, 'refused');
  if (missing.status !== 'refused') return;
  assert.equal(missing.stage, 'approval');
  assert.equal(fake.calls.length, 0);
});

// ----------------------------------------------------- 6. no purchase anywhere

const PURCHASE_PATTERNS: readonly RegExp[] = [
  /comprar/i,
  /\bpurchase/i,
  /\bbuy\b/i,
  /\bpay\b/i,
  /\bpayment\b/i,
  /checkout/i,
  /\bpagar\b/i,
  /\bpago\b/i,
];

/** Comments are stripped so documentation may name the excluded action. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('no route, handler or served byte offers a purchase', async () => {
  const { executor } = fakeExecutor();
  const d = await deps(executor);
  const { createRoutes, PAGE_HTML, CLIENT_JS } = await import('../../src/ui/server');

  for (const route of createRoutes(d)) {
    const text = `${route.method} ${route.path} ${route.purpose}`;
    for (const pattern of PURCHASE_PATTERNS) {
      assert.doesNotMatch(text, pattern, `route "${text}" must not offer a purchase`);
    }
  }

  for (const [name, source] of [
    ['the page', PAGE_HTML],
    ['the client script', CLIENT_JS],
  ] as const) {
    for (const pattern of PURCHASE_PATTERNS) {
      assert.doesNotMatch(source, pattern, `${name} must not mention a purchase`);
    }
  }

  // Nor does any source file of the UI, comments aside.
  const dir = path.resolve('src/ui');
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.ts')) continue;
    const source = codeOnly(readFileSync(path.join(dir, entry), 'utf8'));
    for (const pattern of PURCHASE_PATTERNS) {
      assert.doesNotMatch(source, pattern, `src/ui/${entry} must not offer a purchase`);
    }
  }
});

// -------------------------------------------------------- 7. the loopback bind

test('the server listens on 127.0.0.1 only and answers without CORS headers', async () => {
  const { executor } = fakeExecutor();
  const { startUiServer } = await import('../../src/ui/server');
  const started = await startUiServer({ port: 0, deps: await deps(executor) });

  try {
    assert.equal(started.host, '127.0.0.1');
    assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+$/);

    const page = await fetch(started.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(page.headers.get('access-control-allow-origin'), null, 'no CORS: nothing else may call this page');
    const html = await page.text();
    assert.match(html, /<textarea/, 'the page has the paste box');
    assert.match(html, /Analizar/);
    assert.match(html, /Aprobar estos datos/);
    assert.match(html, /Autorizar la creación/);
  } finally {
    await started.close();
  }
});

test('the routes are the page, its script, the shipment actions and the console reads', async () => {
  const { executor } = fakeExecutor();
  const { createRoutes } = await import('../../src/ui/server');
  const routes = createRoutes(await deps(executor));

  assert.deepEqual(
    routes.map((route) => `${route.method} ${route.path}`).sort(),
    [
      'GET /',
      'GET /api/console',
      'GET /app.js',
      'GET /artifacts/',
      'POST /api/analyze',
      'POST /api/approve',
      'POST /api/run',
      'POST /api/session-check',
    ],
  );

  // Exactly one route is a prefix (the artifact tree), and exactly one route can
  // leave the process: the explicit session check.
  assert.deepEqual(
    routes.filter((route) => route.prefix === true).map((route) => route.path),
    ['/artifacts/'],
  );
  assert.deepEqual(
    routes.filter((route) => route.path === '/api/session-check').map((route) => route.method),
    ['POST'],
  );
});

test('candidate purchase paths are 404 and grant nothing', async () => {
  const { executor } = fakeExecutor();
  const { startUiServer } = await import('../../src/ui/server');
  const started = await startUiServer({ port: 0, deps: await deps(executor) });

  try {
    for (const candidate of ['/comprar', '/comprar-etiqueta', '/api/comprar', '/api/purchase', '/api/pay', '/buy']) {
      const response = await fetch(`${started.url}${candidate}`, { method: 'POST', body: '{}' });
      assert.equal(response.status, 404, `${candidate} must not exist`);
      const body = await response.text();
      assert.doesNotMatch(body, /ok|created/i);
    }
  } finally {
    await started.close();
  }
});

test('the HTTP layer drives the same gates as the CLI', async () => {
  const fake = fakeExecutor();
  const { startUiServer } = await import('../../src/ui/server');
  const d = await deps(fake.executor);
  const started = await startUiServer({ port: 0, deps: d });

  try {
    const rejected = await post(`${started.url}/api/analyze`, { message: withoutLine(HAPPY_MESSAGE, 'Calle') });
    assert.equal(rejected.status, 'rejected');

    const analyzed = await post(`${started.url}/api/analyze`, { message: HAPPY_MESSAGE });
    assert.equal(analyzed.status, 'parsed');
    const form = formValuesFromFields(analyzed.fields);

    const approved = await post(`${started.url}/api/approve`, { message: HAPPY_MESSAGE, form });
    assert.equal(approved.status, 'approved');
    assert.equal(approved.approvalHash, EXPECTED_HASH);

    const refused = await post(`${started.url}/api/run`, {
      message: HAPPY_MESSAGE,
      form: { ...form, city: 'Otra Ciudad' },
      mode: 'create',
      approvedHash: approved.approvalHash,
      token: TOKEN,
    });
    assert.equal(refused.status, 'refused');
    assert.equal(refused.stage, 'approval');
    assert.equal(fake.calls.length, 0);

    const badUser = await fetch(`${started.url}/api/run`, { method: 'POST', body: 'not json' });
    assert.equal(badUser.status, 400);
  } finally {
    await started.close();
  }
});

async function post(url: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, `${url} answered ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

test('the outcome record path helper matches the two-file record shape', () => {
  assert.equal(outcomeRecordPath('dir', 'run-1'), 'dir/run-1.outcome.json');
  assert.equal(attemptRecordPath('dir', 'run-1'), 'dir/run-1.json');
});

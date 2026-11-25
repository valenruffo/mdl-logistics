/**
 * The queue-drain sucursal fill regression (Posadas 2026-11-25, trace of
 * `executor-2026-11-25T21-42-48-207Z`).
 *
 * The live trace fingerprint: the phone field was `fill+type+press` **twice**
 * and every package field (`box.height/width/depth/weight`, `declaredValue`)
 * **zero** writes, then the walk aborted on screen P. Root cause: the panel's
 * phone input is masked (`mask="999999999999999"`) and normalizes the typed
 * text to its digits — `"376 463-4364"` reads back `"3764634364"` — so the
 * drift check's byte-for-byte comparison reported a false drift, its one
 * refill pass re-typed the phone (the double write), still mismatched, and
 * threw inside `fillAgencyRecipient` — before `fillAgencyPackage` ever ran.
 *
 * This file models the observed behavior in the harness (the digit mask on
 * the fake phone input) and asserts the per-journey invariants the live bug
 * broke: every field is written exactly once, and two consecutive drained
 * runs each hold their own payload.
 *
 * Everything is offline and fictional (R11): the two drained entries are the
 * queue's own path (`requestFromForm` over the posted form values, approved
 * hash computed server-side from that request) against the fake panel — no
 * browser, no network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { computeSucursalApprovalHash } from '../../src/cli/gates';
import type { SucursalShipmentRequest } from '../../src/core/types';
import { EnvioNube } from '../../src/executor/envioNube';
import { ExecutorError } from '../../src/executor/errors';
import { STORE_ORIGIN_VARIABLE } from '../../src/executor/panel';
import type { SucursalJourneyReadback } from '../../src/executor/run';
import { sucursalCreateAgainst } from '../../src/executor/run';
import { analyzeMessage } from '../../src/ui/actions';
import { formValuesFromFields, requestFromForm } from '../../src/ui/form';
import { buildSucursalHarness, type SucursalHarness } from './sucursal-harness';

if (process.env[STORE_ORIGIN_VARIABLE] === undefined) {
  process.env[STORE_ORIGIN_VARIABLE] = 'https://tienda-ejemplo.test';
}

/**
 * The first drained entry, shaped like the live Posadas failure: Misiones,
 * CP 3300, and — the trigger — a **formatted phone** the real message carried.
 */
const POSADAS_MESSAGE = [
  '*MDL - Datos de envío*',
  '',
  'Modalidad: sucursal',
  'Sucursal (nombre): Sucursal Posadas Centro (Av. López Torres) - Av. López Torres 1234, Posadas, Misiones',
  '*Código postal*: 3300',
  '',
  '*Datos del destinatario*',
  '*Nombre*: Iara',
  '*Apellido*: Ferreyra',
  '*Email*: iara@ejemplo.com',
  '*Teléfono*: 376 463-4364',
].join('\n');

/** The second drained entry: a different recipient and a differently spelled phone. */
const SECOND_MESSAGE = [
  '*MDL - Datos de envío*',
  '',
  'Modalidad: sucursal',
  'Sucursal (nombre): Sucursal Posadas Centro (Av. López Torres) - Av. López Torres 1234, Posadas, Misiones',
  '*Código postal*: 3300',
  '',
  '*Datos del destinatario*',
  '*Nombre*: Ramón',
  '*Apellido*: Suárez',
  '*Email*: ramon@ejemplo.com',
  '*Teléfono*: +54 376 111-2233',
].join('\n');

/**
 * The panel's own option spelling (decorated with the `Sucursal - ` prefix and
 * the trailing city), matched by street+number identity against the message.
 * Real CP 3300 Misiones branches live in Posadas; the address is fictional.
 */
const POSADAS_BRANCHES = [
  'Sucursal - Posadas Centro (Av. López Torres) - Av. López Torres 1234, Posadas, Misiones',
].map((text) => ({ value: 'uuid-posadas-centro', text }));

/** Every screen-P field the walk writes, in write order. */
const SCREEN_P_FIELDS = [
  'customer.name',
  'customer.surname',
  'customer.email',
  'customer.phoneNumber',
  'box.height',
  'box.width',
  'box.depth',
  'box.weight',
  'declaredValue',
];

/** Screen Q adds exactly one write: the destination postal code. */
const SCREEN_Q_FIELDS = ['address.zipCode'];

interface DrainedRun {
  readonly harness: SucursalHarness;
  /** The journey the panel held after the walk; `null` when the run aborted. */
  readonly journey: SucursalJourneyReadback | null;
  /** A `null` failure is the created outcome; anything else names the abort. */
  readonly failure: string | null;
}

/** Builds the request the way the queue does: from the posted form values. */
function requestOf(message: string): SucursalShipmentRequest {
  const analyzed = analyzeMessage(message);
  assert.equal(analyzed.status, 'parsed', `the drained message must parse; got ${JSON.stringify(analyzed.status)}`);
  if (analyzed.status !== 'parsed') throw new Error('unreachable');
  const built = requestFromForm(formValuesFromFields(analyzed.fieldsByModalidad.sucursal));
  assert.ok(built as { ok: boolean }, 'the posted form must build into a request');
  if (!built.ok) throw new Error('unreachable');
  const request = built.value;
  assert.equal(request.modality, 'sucursal', 'the drained entry is a sucursal entry');
  return request;
}

/**
 * One drained queue entry: a fresh fake panel per run (the queue opens a fresh
 * browser session per entry, serially) and the exact create path the queue
 * runs — `sucursalCreateAgainst` with the server-computed approval hash.
 */
async function drain(message: string): Promise<DrainedRun> {
  const request = requestOf(message);
  const approvedPayloadHash = computeSucursalApprovalHash(request);
  const harness = buildSucursalHarness({ branches: POSADAS_BRANCHES });
  const panel = new EnvioNube(harness.page, { timeoutMs: 1_000, readyTimeoutMs: 500, detailTimeoutMs: 1_000 });

  let journey: SucursalJourneyReadback | null = null;
  let failure: string | null = null;
  try {
    const created = await sucursalCreateAgainst(panel, request, approvedPayloadHash);
    journey = created.journey as SucursalJourneyReadback;
  } catch (error) {
    failure =
      error instanceof ExecutorError
        ? `${error.name}: ${error.message}`
        : `unexpected: ${String(error)}`;
  }
  return { harness, journey, failure };
}

/**
 * The fill-log assertion of the contract: every field the journey writes must
 * be written **exactly once** — the live failure wrote the phone twice and
 * then the package fields zero times.
 */
function assertExactlyOneWritePerField(harness: SucursalHarness, label: string): void {
  const counts = harness.writeCounts();
  for (const name of [...SCREEN_P_FIELDS, ...SCREEN_Q_FIELDS]) {
    assert.equal(
      counts[name] ?? 0,
      1,
      `${label}: [name="${name}"] must be written exactly once per journey (fill log: ${JSON.stringify(counts)})`,
    );
  }
  const unexpected = Object.keys(counts).filter(
    (name) => ![...SCREEN_P_FIELDS, ...SCREEN_Q_FIELDS].includes(name),
  );
  assert.deepEqual(unexpected, [], `${label}: fills outside the journey's fields: ${JSON.stringify(unexpected)}`);
}

test('the fake phone input models the live panel mask: typed text keeps only the digits', async () => {
  // The same modeling discipline the declared-value mask test uses: the fake
  // panel must reproduce the observed normalization (`"376 463-4364"` →
  // `"3764634364"`, Posadas 2026-11-25 trace) for the drift-check bug to be
  // reproducible offline.
  const harness = buildSucursalHarness({ branches: POSADAS_BRANCHES });
  const frame = harness.page.frames()[0];
  const field = frame.locator('input[name="customer.phoneNumber"]').first();

  await field.pressSequentially('376 463-4364');

  assert.equal(await field.inputValue(), '3764634364', 'the mask keeps only the typed digits');
});

test('a phone the mask genuinely drops still stops loudly — one refill, then the abort', async () => {
  // A phone mask whose controlled state refuses typed input: the readback is
  // empty after the first write, the drift refill fires once (a bounded,
  // idempotent convergence on a value the panel dropped — never a retry loop)
  // and the walk then stops loudly instead of advancing a half-filled screen.
  const harness = buildSucursalHarness({ branches: POSADAS_BRANCHES, phoneMaskFrozen: true });
  const panel = new EnvioNube(harness.page, { timeoutMs: 1_000, readyTimeoutMs: 500, detailTimeoutMs: 1_000 });
  const request = requestOf(POSADAS_MESSAGE);

  await assert.rejects(
    () => sucursalCreateAgainst(panel, request, computeSucursalApprovalHash(request)),
    (error: unknown) => {
      assert.ok(error instanceof ExecutorError);
      assert.match(error.message, /did not keep the value(s that were)? written/);
      return true;
    },
  );
  // The convergence stays bounded: first write plus exactly one refill, no loop.
  assert.equal(harness.writeCounts()['customer.phoneNumber'], 2);
  // The package fill never ran: the abort happened before it, by design.
  assert.equal(harness.writeCounts()['box.height'] ?? 0, 0);
  assert.equal(harness.createClickCount(), 0);
});

test('two consecutive drained queue entries: one write per field, no abort', async () => {
  const first = await drain(POSADAS_MESSAGE);
  const second = await drain(SECOND_MESSAGE);

  // The fill counts are asserted before anything else, so a RED run names the
  // doubled phone write and the zero package writes exactly as the live trace
  // did.
  assertExactlyOneWritePerField(first.harness, 'first drained entry');
  assertExactlyOneWritePerField(second.harness, 'second drained entry');

  assert.equal(
    first.failure,
    null,
    `the first drained run must not abort (fill log: ${JSON.stringify(first.harness.writeCounts())}); failure: ${first.failure ?? '(none)'}`,
  );
  assert.equal(
    second.failure,
    null,
    `the second drained run must not abort (fill log: ${JSON.stringify(second.harness.writeCounts())}); failure: ${second.failure ?? '(none)'}`,
  );
  assert.equal(first.journey !== null, true);
  assert.equal(second.journey !== null, true);
});

test('each drained run creates with exactly one gated click and its own readback', async () => {
  const first = await drain(POSADAS_MESSAGE);
  const second = await drain(SECOND_MESSAGE);

  for (const [label, run] of [
    ['first', first],
    ['second', second],
  ] as const) {
    if (run.journey === null) {
      assert.fail(`${label} drained run did not complete; failure: ${run.failure ?? '(none)'}`);
    }
  }
  if (first.journey === null || second.journey === null) throw new Error('unreachable');

  assert.equal(first.harness.createClickCount(), 1, 'the first entry made exactly one gated click');
  assert.equal(second.harness.createClickCount(), 1, 'the second entry made exactly one gated click');

  // Each run's readback holds ITS OWN payload: the second run, drained after
  // the first in the same process, must never carry the first entry's values.
  assert.equal(second.journey.screen.name, 'Ramón');
  assert.equal(second.journey.screen.surname, 'Suárez');
  assert.equal(second.journey.screen.email, 'ramon@ejemplo.com');
  // The phone reads back as the mask holds it: the second payload's digits.
  assert.equal(second.journey.screen.phone, '543761112233');

  // And the first run's readback was the first payload (no cross-contamination).
  assert.equal(first.journey.screen.name, 'Iara');
  assert.equal(first.journey.screen.phone, '3764634364');
});

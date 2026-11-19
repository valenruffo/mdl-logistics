/**
 * The sucursal executor slice, offline (R11): the branch-name matching rule and
 * the two-screen wiring against a fake frame harness.
 *
 * The harness (`./sucursal-harness.ts`) reproduces the observed panel structure
 * of `#/agency-shipment` and `#/agency-shipment/quotation` — the real anchors,
 * the unit buttons, the hidden freight radios, the UUID-valued branch options —
 * and records every click, so these tests can prove both that the panel is
 * driven correctly and that `Crear envío` is never clicked by a dry run.
 *
 * Everything is fictional: invented names, UUID stand-in values, no browser.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { computeSucursalApprovalHash } from '../../src/cli/gates';
import { parseMessage } from '../../src/core/parse-message';
import type { SucursalShipmentRequest } from '../../src/core/types';
import {
  EnvioNube,
  matchSucursalBranch,
  SUCURSAL_CARRIER_NAME,
  type BranchOption,
} from '../../src/executor/envioNube';
import { ExecutorError } from '../../src/executor/errors';
import { STORE_ORIGIN_VARIABLE } from '../../src/executor/panel';
import { sucursalCreateAgainst, sucursalDryRunAgainst } from '../../src/executor/run';
import { buildSucursalHarness, type SucursalHarness } from './sucursal-harness';

/**
 * The sucursal walk now enters by **direct URL navigation**, which composes the
 * admin entry URL from `MDL_STORE_ORIGIN`. The offline harness still runs without
 * real configuration: a fictional `.test` origin (RFC 6761) covers the suite and
 * is restored when it ends — the fake panel never sees the URL, only the fake
 * page's `goto` does, and it resolves the screen from the hash alone.
 */
const FICTIONAL_STORE_ORIGIN = 'https://tienda-ejemplo.test';
const previousStoreOrigin = process.env[STORE_ORIGIN_VARIABLE];
process.env[STORE_ORIGIN_VARIABLE] = FICTIONAL_STORE_ORIGIN;
test.after(() => {
  if (previousStoreOrigin === undefined) delete process.env[STORE_ORIGIN_VARIABLE];
  else process.env[STORE_ORIGIN_VARIABLE] = previousStoreOrigin;
});

/** The real branch option list observed for CP 1419 (plan §4c), UUID values stand in. */
const REAL_OPTIONS: readonly BranchOption[] = [
  {
    index: 1,
    value: 'uuid-villa-devoto',
    text: 'Villa Devoto (Av Beiro) - Av. Francisco Beiró, 4740, C.A.B.A., Buenos Aires',
  },
  { index: 2, value: 'uuid-hop-1', text: 'Punto Andreani Hop - Av. San Martín 5001, C.A.B.A., Buenos Aires' },
  { index: 3, value: 'uuid-hop-2', text: 'Punto Andreani Hop - Av. Triunvirato 4300, C.A.B.A., Buenos Aires' },
];

const MESSAGE = [
  '*MDL - Datos de envío*',
  '',
  'Modalidad: sucursal',
  'Sucursal (nombre): Villa Devoto (Av Beiro) - Av. Francisco Beiró, 4740, C.A.B.A., Buenos Aires',
  '*Código postal*: 1419',
  '',
  '*Datos del destinatario*',
  '*Nombre*: Marta',
  '*Apellido*: García',
  '*Email*: marta@ejemplo.com',
  '*Teléfono*: 1155667788',
].join('\n');

const REQUEST = (() => {
  const parsed = parseMessage(MESSAGE);
  assert.ok(parsed.ok, 'the fictional fixture must parse');
  if (!parsed.ok) throw new Error('unreachable');
  assert.equal(parsed.value.modality, 'sucursal');
  return parsed.value as SucursalShipmentRequest;
})();

const APPROVED_HASH = computeSucursalApprovalHash(REQUEST);

function newPanel(harness: SucursalHarness): EnvioNube {
  // Bounded, fast timeouts: a harness failure must abort in seconds, not minutes.
  return new EnvioNube(harness.page, { timeoutMs: 1_000, readyTimeoutMs: 500, detailTimeoutMs: 1_000 });
}

// --------------------------------------------------- 1. the branch matching rule

test('branch matching is exact after normalization (case, accents, whitespace)', () => {
  const variants = [
    'Villa Devoto (Av Beiro) - Av. Francisco Beiró, 4740, C.A.B.A., Buenos Aires',
    'villa devoto (av beiro) - av. francisco beiro, 4740, c.a.b.a., buenos aires',
    '  Villa  Devoto   (Av Beiro)  -  AV. FRANCISCO BEIRÓ, 4740, C.A.B.A., Buenos Aires  ',
  ];
  for (const variant of variants) {
    const match = matchSucursalBranch(variant, REAL_OPTIONS);
    assert.equal(match.kind, 'unique', `expected the variant to match: ${variant}`);
    if (match.kind !== 'unique') throw new Error('unreachable');
    assert.equal(match.option.value, 'uuid-villa-devoto', 'the matched option is the panel’s own UUID value');
    assert.equal(match.option.text, REAL_OPTIONS[0].text, 'the matched text is the panel’s own spelling');
  }
});

test('a branch name that matches no option is a rejection listing the real options', () => {
  const match = matchSucursalBranch('Sucursal Que No Existe', REAL_OPTIONS);
  assert.equal(match.kind, 'none');
  if (match.kind !== 'none') throw new Error('unreachable');
  assert.deepEqual(
    match.options.map((option) => option.text),
    REAL_OPTIONS.map((option) => option.text),
    'the rejection carries the actual option list',
  );

  // The same refusal, end to end, through the page object on the harness.
  const harness = buildSucursalHarness();
  const panel = newPanel(harness);
  const badRequest = { ...REQUEST, sucursal: 'Sucursal Que No Existe' };
  assert.rejects(
    () => sucursalDryRunAgainst(panel, badRequest, computeSucursalApprovalHash(badRequest)),
    (error: unknown) => {
      assert.ok(error instanceof ExecutorError);
      assert.match(error.message, /no sucursal option matches/);
      // The rejection lists the panel's real options, R12.
      for (const option of REAL_OPTIONS) {
        assert.ok(
          error.details.some((detail) => detail.includes(option.text)),
          `the rejection lists ${option.text}`,
        );
      }
      return true;
    },
  );
});

test('multiple near matches still reject: substring overlap is never a selection', () => {
  const match = matchSucursalBranch('Punto Andreani Hop', REAL_OPTIONS);
  assert.equal(match.kind, 'none', 'two options contain the request, so nothing is selected');
  if (match.kind !== 'none') throw new Error('unreachable');
  assert.equal(match.nearMatches.length, 2, 'both Hop options are reported as near matches');

  const reversed = matchSucursalBranch(
    'Punto Andreani Hop - Av. Triunvirato 4300, C.A.B.A., Buenos Aires (retiro por mostrador)',
    REAL_OPTIONS,
  );
  assert.equal(reversed.kind, 'none', 'a request containing one option verbatim is still not an exact match');
});

test('two options equal after normalization are ambiguous, never auto-selected', () => {
  const duplicated: BranchOption[] = [
    { index: 0, value: 'uuid-a', text: 'Sucursal Centro - Av. Siempre Viva 742' },
    { index: 1, value: 'uuid-b', text: 'sucursal  centro  -  av. siempre viva 742' },
    { index: 2, value: 'uuid-c', text: 'Sucursal Otro Lado' },
  ];
  const match = matchSucursalBranch('Sucursal Centro - Av. Siempre Viva 742', duplicated);
  assert.equal(match.kind, 'ambiguous');
  if (match.kind !== 'ambiguous') throw new Error('unreachable');
  assert.deepEqual(match.matches.map((option) => option.value), ['uuid-a', 'uuid-b']);
});

test('an empty branch name matches nothing', () => {
  const match = matchSucursalBranch('   ', REAL_OPTIONS);
  assert.equal(match.kind, 'none');
});

// --------------------------------------------------- 2. the two-screen wiring

test('dry run: walks both screens, selects carrier and branch, and never clicks Crear envío', async () => {
  const harness = buildSucursalHarness();
  const panel = newPanel(harness);

  const result = await sucursalDryRunAgainst(panel, REQUEST, APPROVED_HASH);

  // The walk starts by direct URL navigation to the verified agency entry.
  assert.deepEqual(harness.navigations, ['/agency-shipment'], 'the entry navigation mounted the agency route');

  assert.equal(result.modality, 'sucursal');
  assert.equal(result.stoppedAt, 'agency-quotation', 'the terminal state is the selected branch, not a summary');
  assert.equal(result.formMatchesApproval, true, 'the panel readback hashes to the approved sucursal payload');
  assert.deepEqual(result.mismatches, []);
  assert.equal(result.createButtonPresent, true, 'the create button is visible on screen Q');

  // The unpaid-side invariant: nothing irreversible happened.
  assert.equal(harness.createClickCount(), 0);
  assert.ok(!harness.clicks.includes('Crear envío'));
  assert.ok(harness.clicks.includes('Continuar'), 'screen P was advanced');
  assert.equal(harness.checkedFreightLabel(), SUCURSAL_CARRIER_NAME, 'the active approved carrier was clicked');

  // Panel state, exactly as the observed anchors hold it.
  const values = harness.inputValues();
  assert.equal(values['customer.surname'], 'García', 'the request lastName went into customer.surname');
  assert.equal(values['customer.lastName'], undefined, 'the domicilio lastName anchor does not exist here');
  assert.equal(values['customer.name'], 'Marta');
  assert.equal(values['customer.email'], 'marta@ejemplo.com');
  assert.equal(values['customer.phoneNumber'], '1155667788');
  assert.equal(values['box.height'], String(REQUEST.box.heightCm));
  assert.equal(values['box.weight'], String(REQUEST.box.weightG));
  assert.equal(values['declaredValue'], '100000', 'the declared value from the request was written');
  assert.equal(values['address.zipCode'], '1419', 'the screen-Q zip anchor, not domicilio zipCode');
  assert.equal(harness.selectedBranchValue(), 'uuid-villa-devoto', 'the branch was selected by its UUID value');
  assert.equal(harness.framePath(), '/agency-shipment/quotation');

  // The dropdown's selected option text matches the approved name after normalization.
  assert.equal(result.journey.branch.selectedText, REAL_OPTIONS[0].text);
});

test('the walk enters by direct URL navigation to the agency route, never the domicilio entry', async () => {
  const harness = buildSucursalHarness();
  const panel = newPanel(harness);

  await sucursalDryRunAgainst(panel, REQUEST, APPROVED_HASH);

  // The only navigation the walk performs is the verified agency entry: the
  // admin page goto whose hash mounts the app frame on `/agency-shipment` and
  // shows Screen P directly (plan §4c, "Screen Entry — verified"). The shared
  // domicilio URL (`#/create-single-shipment`) is never used here.
  assert.deepEqual(harness.navigations, ['/agency-shipment']);
  assert.ok(!harness.navigations.includes('/create-single-shipment'), 'the domicilio entry point was never used');
  assert.ok(!harness.navigations.some((path) => path.includes('create-single-shipment')));

  // The create walk shares the same entry, navigated exactly once.
  const createHarness = buildSucursalHarness();
  const createPanel = newPanel(createHarness);
  await sucursalCreateAgainst(createPanel, REQUEST, APPROVED_HASH);
  assert.deepEqual(createHarness.navigations, ['/agency-shipment'], 'one agency-entry navigation, then the gated create');
});

test('a weight shown in kg aborts screen P with nothing package-related filled', async () => {
  const harness = buildSucursalHarness({ units: { weight: 'kg' } });
  const panel = newPanel(harness);

  await assert.rejects(
    () => sucursalDryRunAgainst(panel, REQUEST, APPROVED_HASH),
    (error: unknown) => {
      assert.ok(error instanceof ExecutorError);
      assert.match(error.message, /unit controls do not match/);
      assert.ok(error.details.some((detail) => detail.includes('expected "g"')));
      return true;
    },
  );
  assert.equal(harness.inputValues()['box.weight'], '', 'no magnitude was written under the wrong unit');
  assert.equal(harness.createClickCount(), 0);
});

test('a request without a declared value refuses screen P, where it is required', async () => {
  const harness = buildSucursalHarness();
  const panel = newPanel(harness);
  const noDeclared: SucursalShipmentRequest = {
    ...REQUEST,
    box: { heightCm: REQUEST.box.heightCm, widthCm: REQUEST.box.widthCm, depthCm: REQUEST.box.depthCm, weightG: REQUEST.box.weightG },
  };

  await assert.rejects(
    () => sucursalDryRunAgainst(panel, noDeclared, computeSucursalApprovalHash(noDeclared)),
    (error: unknown) => {
      assert.ok(error instanceof ExecutorError);
      assert.match(error.message, /declared value is required/);
      return true;
    },
  );
});

test('a changed payload hash stops the create path before anything is clicked', async () => {
  const harness = buildSucursalHarness();
  const panel = newPanel(harness);

  await assert.rejects(
    () => sucursalCreateAgainst(panel, REQUEST, 'f'.repeat(64)),
    (error: unknown) => {
      assert.ok(error instanceof ExecutorError);
      assert.match(error.message, /does not match the approved payload hash/);
      return true;
    },
  );
  assert.equal(harness.createClickCount(), 0, 'the hash gate fired before the click');
});

test('create mode: one gated click, then the unpaid label is proven structurally', async () => {
  const harness = buildSucursalHarness();
  const panel = newPanel(harness);

  const result = await sucursalCreateAgainst(panel, REQUEST, APPROVED_HASH);

  assert.equal(result.modality, 'sucursal');
  assert.equal(result.outcome, 'created');
  if (result.outcome !== 'created') throw new Error('unreachable');
  assert.equal(result.shipment.shipmentId, '#EM1053');
  assert.equal(result.shipment.shipmentIdHeading, '#EM1053');
  assert.ok(result.shipment.statusBadges.includes('Por enviar'));
  assert.equal(result.shipment.buyButtonVisible, true, 'Comprar is visible — inspected, never clicked');
  assert.ok(!harness.clicks.includes('Comprar'));
  assert.equal(harness.framePath(), '/shipping-details/EM1053', 'the detail route was asserted');
  assert.equal(harness.createClickCount(), 1, 'exactly one gated click');

  // A second click in the same run is refused: reconcile, never retry.
  await assert.rejects(
    () => panel.createAgencyShipment({ approvedHash: APPROVED_HASH, payload: {
      zipCode: REQUEST.zipCode,
      sucursal: REQUEST.sucursal,
      carrier: SUCURSAL_CARRIER_NAME,
      height: '', width: '', depth: '', weight: '', declaredValue: '',
      customer: { name: '', surname: '', email: '', phone: '' },
    } }),
    (error: unknown) => {
      assert.ok(error instanceof ExecutorError);
      assert.match(error.message, /second time/);
      return true;
    },
  );
  assert.equal(harness.createClickCount(), 1);
});

test('the sucursal carrier is picked from Modalidades activas, ignoring inactive cards', async () => {
  const harness = buildSucursalHarness();
  const panel = newPanel(harness);

  await panel.fillAgencyRecipient({ customer: REQUEST.customer });
  await panel.fillAgencyPackage(REQUEST.box);
  await panel.continueFromAgencyRecipient();
  const carrier = await panel.selectCarrierSucursal();

  assert.equal(carrier.selectedName, SUCURSAL_CARRIER_NAME);
  assert.equal(carrier.panelName, SUCURSAL_CARRIER_NAME);
  assert.equal(carrier.checked, true);
  const active = carrier.diagnostics.find((option) => option.group === 'activas');
  assert.ok(active, 'the approved card was resolved inside Modalidades activas');
  assert.equal(active.checked, true);
  const inactive = carrier.diagnostics.find((option) => option.group === 'inactivas');
  assert.ok(inactive, 'the inactive card was classified by the preceding heading');
  assert.equal(inactive.checked, false, 'the inactive card was never clicked');
});

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
import { parseArsAmount } from '../../src/executor/currency';
import { ExecutorError, PreClickAbortError } from '../../src/executor/errors';
import { STORE_ORIGIN_VARIABLE } from '../../src/executor/panel';
import { DASHBOARD_WAIT_VARIABLE, gotoAgencyEntry } from '../../src/executor/session';
import { sucursalCreateAgainst, sucursalDryRunAgainst, walkSucursalToQuotation } from '../../src/executor/run';
import { buildSucursalHarness, DEFAULT_BRANCHES, type HarnessOption, type SucursalHarness } from './sucursal-harness';

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
  assert.equal(match.rule, 'full-text', 'no number in the name, so the full-text fallback decided');
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
      assert.match(error.message, /full text \(exact after normalization\) rule failed/, 'the rejection names which rule failed');
      // The rejection lists the panel's real options, R12.
      for (const option of DEFAULT_BRANCHES) {
        assert.ok(
          error.details.some((detail) => detail.includes(option.text)),
          `the rejection lists ${option.text}`,
        );
      }
      return true;
    },
  );
});

test('the street+number rule: no option containing the pair is a rejection naming the street-pair rule', () => {
  // The harness dropdown holds the decorated Villa Devoto / Hop options only,
  // so an approved name for a different address finds no street candidate.
  const harness = buildSucursalHarness();
  const panel = newPanel(harness);
  const badRequest = { ...REQUEST, sucursal: 'Gral. San Martin 979 San Salvador de Jujuy' };
  assert.rejects(
    () => sucursalDryRunAgainst(panel, badRequest, computeSucursalApprovalHash(badRequest)),
    (error: unknown) => {
      assert.ok(error instanceof ExecutorError);
      assert.match(error.message, /no sucursal option matches/);
      assert.match(error.message, /street\+number pair rule failed/, 'the rejection names which rule failed');
      assert.ok(
        error.details.some((detail) => detail.includes('street "martin"') && detail.includes('"979"')),
        'the rejection names the parsed pair — the last word before the number, per the operator\'s rule',
      );
      for (const option of DEFAULT_BRANCHES) {
        assert.ok(error.details.some((detail) => detail.includes(option.text)), `the rejection lists ${option.text}`);
      }
      return true;
    },
  );
});

test('two options with the identical street+number pair are ambiguous; different numbers on the same street are not', async () => {
  // Genuinely ambiguous: the SAME pair on two options (co-located duplicate
  // points). Rejection is the safe behavior.
  const duplicated: HarnessOption[] = [
    { value: 'uuid-san-martin-979', text: 'Sucursal - Gral. San Martin 979, Jujuy' },
    { value: 'uuid-san-martin-979-hop', text: 'Punto Andreani Hop - Gral. San Martin 979, Jujuy' },
    { value: 'uuid-otra', text: 'Sucursal - Corrientes 580, Jujuy' },
  ];
  const ambiguous = matchSucursalBranch('Gral. San Martin 979', duplicated);
  assert.equal(ambiguous.kind, 'ambiguous', 'two options carrying the identical pair are a real ambiguity; both are named');
  if (ambiguous.kind !== 'ambiguous') throw new Error('unreachable');
  assert.equal(ambiguous.rule, 'street-number-pair');
  assert.equal(ambiguous.reason, 'street-shared-by-multiple-options');
  assert.deepEqual(
    ambiguous.matches.map((option) => option.value),
    ['uuid-san-martin-979', 'uuid-san-martin-979-hop'],
    'both identical-pair candidates are named',
  );

  // End to end: the rejection names both options and the street rule.
  const duplicatedHarness = buildSucursalHarness({ branches: duplicated });
  const duplicatedPanel = newPanel(duplicatedHarness);
  const duplicatedRequest = { ...REQUEST, sucursal: 'Gral. San Martin 979' };
  assert.rejects(
    () => sucursalDryRunAgainst(duplicatedPanel, duplicatedRequest, computeSucursalApprovalHash(duplicatedRequest)),
    (error: unknown) => {
      assert.ok(error instanceof ExecutorError);
      assert.match(error.message, /matches the approved branch street\+number pair more than once/);
      assert.ok(error.details.some((detail) => detail.includes('uuid-san-martin-979')));
      assert.ok(error.details.some((detail) => detail.includes('uuid-san-martin-979-hop')));
      return true;
    },
  );

  // Different numbers are different pairs: `979` pins one option — never an
  // ambiguity, never a rejection.
  const distinct: HarnessOption[] = [
    { value: 'uuid-san-martin-979', text: 'Sucursal - Gral. San Martin 979, Jujuy' },
    { value: 'uuid-san-martin-1327', text: 'Sucursal - Gral. San Martin 1327, Jujuy' },
    { value: 'uuid-otra', text: 'Sucursal - Corrientes 580, Jujuy' },
  ];
  const unique = matchSucursalBranch('Gral. San Martin 979', distinct);
  assert.equal(unique.kind, 'unique', 'the number disambiguates same-street branches with different numbers');
  if (unique.kind !== 'unique') throw new Error('unreachable');
  assert.equal(unique.rule, 'street-number-pair');
  assert.equal(unique.option.value, 'uuid-san-martin-979');

  // End to end: the same distinct list selects the pinned option through the
  // page object, and `Crear envío` stays untouched.
  const distinctHarness = buildSucursalHarness({ branches: distinct });
  const distinctPanel = newPanel(distinctHarness);
  const distinctRequest = { ...REQUEST, sucursal: 'Gral. San Martin 979' };
  const distinctHash = computeSucursalApprovalHash(distinctRequest);
  const result = await sucursalDryRunAgainst(distinctPanel, distinctRequest, distinctHash);
  assert.equal(result.journey.branch.selectedValue, 'uuid-san-martin-979');
  assert.equal(distinctHarness.createClickCount(), 0);
});

test('a street-only match whose number differs aborts naming the near match, never selecting it', () => {
  const harness = buildSucursalHarness();
  const panel = newPanel(harness);
  const streetOnlyRequest = { ...REQUEST, sucursal: 'Av. Triunvirato 4400, C.A.B.A., Buenos Aires' };
  assert.rejects(
    () => sucursalDryRunAgainst(panel, streetOnlyRequest, computeSucursalApprovalHash(streetOnlyRequest)),
    (error: unknown) => {
      assert.ok(error instanceof ExecutorError);
      assert.match(error.message, /no sucursal option matches/);
      assert.match(error.message, /street\+number pair rule failed/);
      assert.ok(
        error.details.some((detail) => detail.includes('street-only match is never selected')),
        'the stop names the street-only refusal',
      );
      assert.ok(
        error.details.some((detail) => detail.includes('Av. Triunvirato 4300')),
        'the near match (the real branch on that street, different number) is reported',
      );
      return true;
    },
  );
  assert.equal(harness.createClickCount(), 0);
  assert.equal(harness.selectedBranchValue(), '', 'no branch option was ever selected');
});

test('multiple near matches still reject: substring overlap is never a selection', () => {
  const match = matchSucursalBranch('Punto Andreani Hop', REAL_OPTIONS);
  assert.equal(match.kind, 'none', 'no number in the approved name → full-text fallback; two options contain the request, so nothing is selected');
  if (match.kind !== 'none') throw new Error('unreachable');
  assert.equal(match.rule, 'full-text', 'the fallback rule is reported');
  assert.equal(match.nearMatches.length, 2, 'both Hop options are reported as near matches');

  // A request that contains one option verbatim plus trailing decoration now
  // uniquely matches by street+number identity — the live-failure fix. The
  // panel's own option text is still what gets selected.
  const reversed = matchSucursalBranch(
    'Punto Andreani Hop - Av. Triunvirato 4300, C.A.B.A., Buenos Aires (retiro por mostrador)',
    REAL_OPTIONS,
  );
  assert.equal(reversed.kind, 'unique', 'the street+number pair pins exactly one option despite the extra decoration');
  if (reversed.kind !== 'unique') throw new Error('unreachable');
  assert.equal(reversed.rule, 'street-number-pair');
  assert.equal(reversed.option.value, 'uuid-hop-2', 'the matched option is the panel’s own spelling, never the request’s');

  // Same street, different number: the pair is (street AND number), so this is
  // a street-only near match — reported, never selected.
  const otherNumber = matchSucursalBranch('Punto Andreani Hop - Av. Triunvirato 4400', REAL_OPTIONS);
  assert.equal(otherNumber.kind, 'none', 'a street-only match with a different number is never a selection');
  if (otherNumber.kind !== 'none') throw new Error('unreachable');
  assert.equal(otherNumber.rule, 'street-number-pair');
  assert.deepEqual(
    otherNumber.nearMatches.map((option) => option.value),
    ['uuid-hop-2'],
    'the street-only candidate is reported as a near match',
  );
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

  // The walk starts by the two-hop entry: dashboard first, then the agency hash.
  assert.deepEqual(harness.navigations, ['/dashboard', '/agency-shipment'], 'the two-hop entry mounted the agency route');

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
  assert.equal(
    values['declaredValue'],
    '$ 100.000,00',
    'the masked declared-value input holds the approved amount in the panel format',
  );
  assert.equal(parseArsAmount(values['declaredValue'] ?? ''), 100000, 'the numeric readback equals the approved declaredValueArs');
  assert.equal(
    result.journey.screen.declaredValue,
    '$ 100.000,00',
    'the screen readback carries the masked format, compared numerically downstream',
  );
  assert.equal(values['address.zipCode'], '1419', 'the screen-Q zip anchor, not domicilio zipCode');
  assert.equal(harness.selectedBranchValue(), 'uuid-villa-devoto', 'the branch was selected by its UUID value');
  assert.equal(harness.framePath(), '/agency-shipment/quotation');

  // The dropdown's selected option text is the panel's own decorated spelling;
  // the request name (bare) and the option (prefix + city decoration) name the
  // same branch by street+number identity.
  assert.equal(result.journey.branch.selectedText, DEFAULT_BRANCHES[0].text);
});

test('the live readback failure end to end: the `Jujuy (Centro) - ` echoed option text verifies by identity', async () => {
  // The observed live CP-4800 dropdown shape: the real branch carries the
  // `Jujuy (Centro) - ` prefix and a comma before the number, and the panel
  // echoes that decorated text back after the write. The walk must select it
  // by street+number pair AND the post-write readback must agree by the same
  // identity — select → readback → identity equal → success.
  const branches: HarnessOption[] = [
    { value: 'uuid-4600-real', text: 'Jujuy (Centro) - Gral. San Martín, 979, San Salvador De Jujuy, Jujuy' },
    {
      value: 'uuid-4600-hop',
      text: 'Punto Andreani Hop Lamadrid 177 - Lamadrid, 177 Entrecalles gral san martin e independencia, San Salvador De Jujuy, Jujuy',
    },
  ];
  const harness = buildSucursalHarness({ branches });
  const panel = newPanel(harness);
  const request = { ...REQUEST, zipCode: '4800', sucursal: 'Gral. San Martin 979 San Salvador de Jujuy' };
  const result = await sucursalDryRunAgainst(panel, request, computeSucursalApprovalHash(request));

  assert.equal(result.journey.branch.selectedValue, 'uuid-4600-real', 'the bare approved name pinned the decorated option');
  assert.equal(
    result.journey.branch.selectedText,
    'Jujuy (Centro) - Gral. San Martín, 979, San Salvador De Jujuy, Jujuy',
    'the readback is the panel\'s own decorated spelling, verified by identity, not rejected',
  );
  assert.equal(result.formMatchesApproval, true);
  assert.deepEqual(result.mismatches, []);
  assert.equal(harness.createClickCount(), 0, 'the dry run never creates the shipment');
});

test('the walk enters by the two-hop navigation to the agency route, never the domicilio entry', async () => {
  const harness = buildSucursalHarness();
  const panel = newPanel(harness);

  await sucursalDryRunAgainst(panel, REQUEST, APPROVED_HASH);

  // The only navigations the walk performs are the two verified entry hops: the
  // admin page goto to `#/dashboard` (a hash-only goto is a same-document
  // navigation that only re-routes the SPA via the dashboard), then the goto to
  // the agency hash `#/agency-shipment` that mounts Screen P (plan §4c). The
  // shared domicilio URL (`#/create-single-shipment`) is never used here.
  assert.deepEqual(harness.navigations, ['/dashboard', '/agency-shipment']);
  assert.ok(!harness.navigations.includes('/create-single-shipment'), 'the domicilio entry point was never used');
  assert.ok(!harness.navigations.some((path) => path.includes('create-single-shipment')));

  // The create walk shares the same entry, navigated exactly once.
  const createHarness = buildSucursalHarness();
  const createPanel = newPanel(createHarness);
  await sucursalCreateAgainst(createPanel, REQUEST, APPROVED_HASH);
  assert.deepEqual(createHarness.navigations, ['/dashboard', '/agency-shipment'], 'one two-hop entry, then the gated create');
});

test('two-hop entry: the dashboard hop re-routes a frame stranded on the domicilio screen', async () => {
  // The observed live failure started exactly here: the app frame was stuck on
  // the domicilio screen from a previous walk, and the admin hash changed to
  // `#/agency-shipment` without the SPA re-routing the frame.
  const harness = buildSucursalHarness({ initialPath: '/create-single-shipment' });
  const panel = newPanel(harness);

  const result = await sucursalDryRunAgainst(panel, REQUEST, APPROVED_HASH);

  assert.deepEqual(harness.navigations, ['/dashboard', '/agency-shipment'], 'hop 1 mounted the dashboard, hop 2 the agency route');
  assert.equal(harness.framePath(), '/agency-shipment/quotation');
  assert.equal(result.stoppedAt, 'agency-quotation');
  assert.equal(harness.createClickCount(), 0);
});

test('starting already on /agency-shipment (a previous run) still works', async () => {
  // A previous run left the admin app open at `#/agency-shipment` with the frame
  // on the agency route. The same-document gotos need to change nothing, so the
  // walk must still land on Screen P and complete.
  const harness = buildSucursalHarness();
  const panel = newPanel(harness);

  const result = await sucursalDryRunAgainst(panel, REQUEST, APPROVED_HASH);

  assert.equal(result.stoppedAt, 'agency-quotation');
  assert.equal(harness.framePath(), '/agency-shipment/quotation');
  assert.equal(result.formMatchesApproval, true);
  assert.equal(harness.createClickCount(), 0);
});

test('the live-failure shape: an ignored agency hash hop falls back to the dashboard UI once', async () => {
  // Models the panel that did not re-route even from the dashboard: hop 1 works,
  // hop 2 is a no-op. The executor must try the real UI path exactly once
  // ("Agregar envío manual" → "A sucursal") and then land on Screen P.
  const harness = buildSucursalHarness({
    initialPath: '/create-single-shipment',
    ignoredHashRoutes: ['/agency-shipment'],
  });
  const panel = newPanel(harness);

  const result = await sucursalDryRunAgainst(panel, REQUEST, APPROVED_HASH);

  // Hop 1 mounted the dashboard; hop 2 was ignored by the fake SPA (no route).
  // The fallback's own navigation mounted the agency route.
  assert.deepEqual(harness.navigations, ['/dashboard', '/agency-shipment']);
  assert.equal(harness.clicks.filter((click) => click === 'Agregar envío manual').length, 1, 'the fallback clicked the real button once');
  assert.equal(harness.clicks.filter((click) => click === 'A sucursal').length, 1, 'the fallback clicked the exact option once');
  assert.equal(harness.framePath(), '/agency-shipment/quotation');
  assert.equal(result.stoppedAt, 'agency-quotation');
  assert.equal(harness.createClickCount(), 0);
});

test('the fallback never runs when the two-hop entry lands on /agency-shipment', async () => {
  const harness = buildSucursalHarness({ initialPath: '/create-single-shipment' });
  const panel = newPanel(harness);

  await sucursalDryRunAgainst(panel, REQUEST, APPROVED_HASH);

  assert.ok(!harness.clicks.includes('Agregar envío manual'), 'the dashboard UI path was never clicked');
  assert.ok(!harness.clicks.includes('A sucursal'), 'the dropdown option was never clicked');
});

test('the dashboard wait is pacing: it never consumes the goto budget at the hop boundary (≤ 3 s)', async () => {
  // Models the measured live cost: between the two entry gotos the executor
  // waits for the dashboard frame route. The wait is pacing, not a gate — when
  // the frame never mounts there (an ignored dashboard hash hop), the wait must
  // cap at its short budget and hop 2 must still run exactly once, never
  // burning the 60 s goto budget between the hops.
  const previousWait = process.env[DASHBOARD_WAIT_VARIABLE];
  process.env[DASHBOARD_WAIT_VARIABLE] = '250';
  try {
    const harness = buildSucursalHarness({
      initialPath: '/create-single-shipment',
      ignoredHashRoutes: ['/dashboard'],
    });

    await gotoAgencyEntry(harness.page);

    assert.equal(harness.gotoTimes().length, 2, 'both entry hops ran exactly once despite the never-mounting dashboard');
    const gap = (harness.gotoTimes()[1] ?? 0) - (harness.gotoTimes()[0] ?? 0);
    assert.ok(gap <= 3_000, `the dashboard wait must not consume the goto budget (elapsed ${gap} ms between the hops)`);
  } finally {
    if (previousWait === undefined) delete process.env[DASHBOARD_WAIT_VARIABLE];
    else process.env[DASHBOARD_WAIT_VARIABLE] = previousWait;
  }

  // And the very likely case — the frame is already on `/dashboard` after hop 1
  // — must proceed to hop 2 immediately: the gap at the hop boundary stays far
  // below the budget because the first probe already sees the mounted route.
  const mountedHarness = buildSucursalHarness();
  await gotoAgencyEntry(mountedHarness.page);

  assert.equal(mountedHarness.gotoTimes().length, 2, 'both entry hops ran exactly once');
  assert.deepEqual(mountedHarness.navigations, ['/dashboard', '/agency-shipment'], 'the two-hop entry still walks dashboard → agency');
  const mountedGap = (mountedHarness.gotoTimes()[1] ?? 0) - (mountedHarness.gotoTimes()[0] ?? 0);
  assert.ok(mountedGap <= 3_000, `a mounted dashboard proceeds to hop 2 immediately (elapsed ${mountedGap} ms)`);
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

// ------------------------------------------------- R10 as amended: pre-click aborts

test('a refusal during the create walk is a pre-click abort naming the stage reached', async () => {
  // The quotation section that never renders stops the walk mid-journey: still
  // pre-click, so it must come out classified as a pre-click abort.
  const harness = buildSucursalHarness({ quotationDeferral: 'never' });
  const panel = newPanel(harness);

  await assert.rejects(
    () => sucursalCreateAgainst(panel, REQUEST, APPROVED_HASH),
    (error: unknown) => {
      assert.ok(error instanceof PreClickAbortError, 'the walk refusal is classified as a pre-click abort');
      assert.equal(error.stage, 'journey to the branch quotation (screens P-Q)');
      assert.match(error.message, /never appeared/);
      return true;
    },
  );
  assert.equal(harness.createClickCount(), 0, 'nothing was clicked, so nothing was created');
});

test('a create-gate refusal inside the click call is a pre-click abort, not an unknown outcome', async () => {
  const harness = buildSucursalHarness();
  const panel = newPanel(harness);

  // The gates run on screen Q, so the walk completes first: the refusal below
  // is the click call's own precondition, not a journey failure.
  await walkSucursalToQuotation(panel, REQUEST);

  await assert.rejects(
    () =>
      panel.createAgencyShipment({
        approvedHash: 'f'.repeat(64),
        payload: {
          zipCode: REQUEST.zipCode,
          sucursal: REQUEST.sucursal,
          carrier: SUCURSAL_CARRIER_NAME,
          height: '20',
          width: '25',
          depth: '10',
          weight: '700',
          declaredValue: '',
          customer: { name: 'Marta', surname: 'García', email: 'marta@ejemplo.com', phone: '1155667788' },
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof PreClickAbortError, 'the gate runs before the click, so it is a pre-click abort');
      assert.equal(error.stage, 'create gates (sucursal screen Q)');
      assert.match(error.message, /does not match the approved payload hash/);
      return true;
    },
  );
  assert.equal(harness.createClickCount(), 0);
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

test('the fake panel mask reproduces the live failure for a raw programmatic write', async () => {
  // The live dry run wrote the raw digits and the currency mask reinterpreted
  // them: the panel showed `$ 1.000,00` for an approved 100000 and `Continuar`
  // never enabled (25 s timeout). The harness mask must reproduce that exact
  // failure mode for a programmatic value assignment.
  const harness = buildSucursalHarness();
  const frame = harness.page.frames()[0];
  const field = frame.locator('input[name="declaredValue"]').first();
  await field.fill(String(REQUEST.box.declaredValueArs));
  const raw = await field.inputValue();
  assert.equal(raw, '$ 1.000,00', 'the raw write shows the observed live failure');
  assert.equal(parseArsAmount(raw), 1000, 'the mask read 100000 as a cent amount: 1000 ARS, not the approved 100000');
});

test('typing the declared value digit by digit lands the approved amount in the mask', async () => {
  // The mask counts every typed digit as a cent, so the approved 100000 ARS
  // must be typed as "100000,00" (eight digits); the display then reads
  // `$ 100.000,00` and the numeric readback equals 100000.
  const harness = buildSucursalHarness();
  const frame = harness.page.frames()[0];
  const field = frame.locator('input[name="declaredValue"]').first();
  await field.pressSequentially('100000,00');
  const raw = await field.inputValue();
  assert.equal(raw, '$ 100.000,00');
  assert.equal(parseArsAmount(raw), 100000);
});

test('a masked declared value that reads wrong aborts screen P, naming both amounts', async () => {
  // A mask whose controlled state refuses typed input: the readback disagrees
  // with the approved amount, so the walk must stop — no Continuar, no retry.
  const harness = buildSucursalHarness({ declaredValueFrozen: true });
  const panel = newPanel(harness);

  await assert.rejects(
    () => sucursalDryRunAgainst(panel, REQUEST, APPROVED_HASH),
    (error: unknown) => {
      assert.ok(error instanceof ExecutorError);
      assert.match(error.message, /declared value does not match the approved amount/);
      assert.match(error.message, /100000/);
      assert.ok(
        error.details.some((detail) => detail.includes('approved declaredValueArs: 100000')),
        'the stop names the approved amount',
      );
      assert.ok(
        error.details.some((detail) => detail.includes('panel readback of [name="declaredValue"]')),
        'the stop names the panel readback',
      );
      return true;
    },
  );
  assert.ok(!harness.clicks.includes('Continuar'), 'nothing was advanced past the mismatch');
  assert.equal(harness.createClickCount(), 0);
  assert.equal(harness.framePath(), '/agency-shipment', 'the walk stopped on screen P');
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

// ------------------------------------- 3. the asynchronous quotation (observed live)

/**
 * The observed live failure: screen Q renders only `Destino` + `Resumen del
 * envío` until the postal-code quote resolves, and the carrier/branch sections
 * appear afterwards. The harness models the deferral (`quotationDeferral`), and
 * these tests prove the walk waits for the `Modalidad de envío` heading before
 * looking for the carrier radios — or stops loudly when it never renders.
 */
test('the quotation section renders late (after a tick); the walk waits and completes', async () => {
  const harness = buildSucursalHarness({ quotationDeferral: 'tick' });
  const panel = newPanel(harness);

  const result = await sucursalDryRunAgainst(panel, REQUEST, APPROVED_HASH);

  assert.equal(harness.quotationSectionRevealed(), true, 'the panel rendered the carrier/branch section');
  assert.equal(result.stoppedAt, 'agency-quotation', 'the walk completed to the branch selection');
  assert.equal(result.formMatchesApproval, true);
  assert.equal(harness.checkedFreightLabel(), SUCURSAL_CARRIER_NAME, 'the carrier was selected once the section rendered');
  assert.equal(harness.selectedBranchValue(), 'uuid-villa-devoto');
  assert.equal(harness.createClickCount(), 0);
  assert.ok(!harness.clicks.includes('Crear envío'));
});

test('the quotation section renders only after a change on the postal code; the executor dispatches it once', async () => {
  // The quote is gated on the CP change event: nothing renders until the walk
  // dispatches one change/blur on `address.zipCode` — exactly the recovery the
  // executor performs when the heading is missing at half the wait budget.
  const harness = buildSucursalHarness({ quotationDeferral: 'change' });
  const panel = newPanel(harness);

  const result = await sucursalDryRunAgainst(panel, REQUEST, APPROVED_HASH);

  assert.equal(harness.quotationSectionRevealed(), true, 'the dispatched change/blur triggered the quote');
  assert.equal(result.stoppedAt, 'agency-quotation');
  assert.equal(result.formMatchesApproval, true);
  assert.equal(harness.checkedFreightLabel(), SUCURSAL_CARRIER_NAME);
  assert.equal(harness.createClickCount(), 0);
});

test('the quotation section that never renders aborts naming the missing heading and the frame url', async () => {
  const harness = buildSucursalHarness({ quotationDeferral: 'never' });
  const panel = newPanel(harness);

  await assert.rejects(
    () => sucursalDryRunAgainst(panel, REQUEST, APPROVED_HASH),
    (error: unknown) => {
      assert.ok(error instanceof ExecutorError);
      assert.match(error.message, /Modalidad de envío/);
      assert.match(error.message, /never appeared/);
      assert.ok(
        error.details.some((detail) => detail.includes('missing heading: "Modalidad de envío"')),
        'the stop names the missing heading',
      );
      assert.ok(
        error.details.some((detail) => detail.includes('panel frame url:') && detail.includes('/agency-shipment/quotation')),
        'the stop names the frame url',
      );
      return true;
    },
  );
  assert.equal(harness.framePath(), '/agency-shipment/quotation');
  assert.equal(harness.quotationSectionRevealed(), false, 'nothing triggered the quote');
  assert.ok(!harness.clicks.includes('Andreani a sucursal'), 'no carrier card was clicked');
  assert.equal(harness.createClickCount(), 0, 'nothing was created');
});

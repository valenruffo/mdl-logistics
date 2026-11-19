/**
 * Local dry run of the sucursal journey against the fake frame harness — no
 * browser, no live panel, no network (R11). It drives the exact same
 * `sucursalDryRunAgainst` path the real dry run uses, over the recorded panel
 * structure of `tests/unit/sucursal-harness.ts`, and prints the same readback
 * shape the live `npm run sucursal-dry-run` prints — plus the click evidence
 * that `Crear envío` was never clicked. The walk enters by the verified
 * **two-hop navigation** — the dashboard hash first, then the agency hash —
 * because a single same-document goto to `#/agency-shipment` failed live to
 * re-route the app SPA.
 *
 * Not part of `npm test`; run it with `npm run sucursal-harness-dry-run`.
 */
import { computeSucursalApprovalHash } from '../../src/cli/gates';
import { parseMessage } from '../../src/core/parse-message';
import { EnvioNube } from '../../src/executor/envioNube';
import { ExecutorError } from '../../src/executor/errors';
import { STORE_ORIGIN_VARIABLE } from '../../src/executor/panel';
import { sucursalDryRunAgainst } from '../../src/executor/run';
import { buildSucursalHarness } from '../unit/sucursal-harness';

/**
 * The walk enters by direct URL navigation, which composes the admin entry URL
 * from `MDL_STORE_ORIGIN`. This offline harness run carries a fictional `.test`
 * origin (RFC 6761) — never a real store — and never overrides a value the
 * operator already exported.
 */
if (process.env[STORE_ORIGIN_VARIABLE] === undefined) {
  process.env[STORE_ORIGIN_VARIABLE] = 'https://tienda-ejemplo.test';
}

/**
 * Fictional message (R11) with the real branch name observed for CP 1419
 * (plan §4c, "Sucursal — Screen Q"): the executor matches it against the
 * dropdown's own options after normalization.
 */
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

function line(label: string, value: unknown): void {
  console.log(`  ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

async function main(): Promise<number> {
  console.log('MDL Logistics — sucursal dry run (fake frame harness, no browser)');
  console.log('mode: dry-run (walks screens P-Q and STOPS after the branch is selected)');
  console.log('hard rule: "Crear envío" is never clicked, "Comprar" is never clicked');

  const parsed = parseMessage(MESSAGE);
  if (!parsed.ok || parsed.value.modality !== 'sucursal') {
    console.error('\nREFUSED by the parser; the panel was not opened.');
    return 1;
  }
  const request = parsed.value;
  const approvedPayloadHash = computeSucursalApprovalHash(request);

  section('Parsed request (fictional data)');
  line('modality', request.modality);
  line('zipCode', request.zipCode);
  line('sucursal', request.sucursal);
  line('customer', `${request.customer.name} ${request.customer.lastName ?? ''}`);
  line('box (cm/g)', {
    heightCm: request.box.heightCm,
    widthCm: request.box.widthCm,
    depthCm: request.box.depthCm,
    weightG: request.box.weightG,
    declaredValueArs: request.box.declaredValueArs,
  });
  line('approved payload hash', approvedPayloadHash);

  const harness = buildSucursalHarness();
  const panel = new EnvioNube(harness.page, { timeoutMs: 1_000, readyTimeoutMs: 500, detailTimeoutMs: 1_000 });

  try {
    const result = await sucursalDryRunAgainst(panel, request, approvedPayloadHash);

    section('Entry — verified: two-hop navigation (dashboard hash, then the agency hash)');
    line('admin hash navigated', '#/dashboard → #/agency-shipment (two-hop entry)');
    line('navigations recorded by the fake panel', harness.navigations);
    line('screen P frame url', result.journey.screen.url);

    section('Screen P — #/agency-shipment: recipient + package (read back from the panel)');
    line('frame url', result.journey.screen.url);
    line('units', result.journey.screen.units);
    line('customer.name', result.journey.screen.name);
    line('customer.surname (the request lastName)', result.journey.screen.surname);
    line('customer.email', result.journey.screen.email);
    line('customer.phoneNumber', result.journey.screen.phone);
    line('box.height / width / depth (cm)', `${result.journey.screen.height} / ${result.journey.screen.width} / ${result.journey.screen.depth}`);
    line('box.weight (g)', result.journey.screen.weight);
    line('declaredValue ($, required here)', result.journey.screen.declaredValue);
    line('Continuar enabled before advancing', result.journey.screen.continueEnabled);

    section('Screen Q — #/agency-shipment/quotation: destination + carrier + branch');
    line('frame url', result.journey.quotation.url);
    line('address.zipCode', result.journey.quotation.zipCode);
    line('checked carrier (re-read)', result.journey.quotation.checkedCarrierName);
    line('selected carrier', `${result.journey.carrier.selectedName} (checked: ${result.journey.carrier.checked})`);
    line('selected branch (value)', result.journey.quotation.branchSelectedValue);
    line('selected branch (text)', result.journey.branch.selectedText);
    line('dropdown options offered', result.journey.quotation.branchOptions);
    line('"Crear envío" visible (never clicked)', result.journey.quotation.createButtonVisible);

    section('Panel readback vs approved payload');
    line('approved payload hash', result.approvedPayloadHash);
    line('form payload hash', result.formPayloadHash);
    line('form matches approval', result.formMatchesApproval);
    line('field mismatches', result.mismatches.length);
    for (const mismatch of result.mismatches) console.log(`    - ${mismatch}`);

    section('Stopped state');
    line('stoppedAt', result.stoppedAt);
    line('create button clicks', harness.createClickCount());
    line('clicks recorded', harness.clicks);

    if (!result.formMatchesApproval || result.mismatches.length > 0) {
      console.error('\nFAILED: the panel readback does not match the approved payload.');
      return 1;
    }
    if (harness.createClickCount() !== 0) {
      console.error('\nFAILED: the dry run clicked "Crear envío". That must be impossible.');
      return 1;
    }
    if (
      harness.navigations.length !== 2 ||
      harness.navigations[0] !== '/dashboard' ||
      harness.navigations[1] !== '/agency-shipment'
    ) {
      console.error(
        `\nFAILED: the walk must enter by the two-hop navigation — dashboard first, then the agency route (navigations: ${JSON.stringify(harness.navigations)}).`,
      );
      return 1;
    }

    console.log(
      '\nSTOPPED AFTER THE BRANCH SELECTION: no shipment was created and no label was purchased.',
    );
    return 0;
  } catch (error) {
    if (error instanceof ExecutorError) {
      console.error(`\nSTOPPED: ${error.name}: ${error.message}`);
      for (const detail of error.details) console.error(`  - ${detail}`);
      return 1;
    }
    console.error('\nSTOPPED: unexpected error');
    console.error(error);
    return 1;
  }
}

process.exitCode = await main();

/**
 * LIVE sucursal dry run against the real Envío Nube panel (not part of `npm test`).
 *
 * Why it is not in `npm test`: it needs the live panel, a human-prepared
 * logged-in browser profile, and it drives the real sucursal journey. Core tests
 * stay offline and deterministic (the offline twin of this script is
 * `npm run sucursal-harness-dry-run`).
 *
 * What it does, in order: screen P (`#/agency-shipment`) verifies the unit
 * buttons (`cm` ×3 + `g`, `$` for the required declared value) before anything
 * is written, fills the recipient (note the panel's `customer.surname` anchor)
 * and the package, waits for `Continuar` to become enabled and advances to
 * screen Q (`#/agency-shipment/quotation`), where it writes the destination
 * postal code (`address.zipCode` — a different anchor from domicilio's
 * `zipCode`), selects `Andreani a sucursal` inside `Modalidades activas`, and
 * selects the branch by option text (exact after normalization; an unknown
 * branch is a rejection listing the real options).
 *
 * What it never does: click `Crear envío` or `Comprar`. The run stops after the
 * branch selection. Nothing is created and nothing is purchased.
 *
 * Run: `npm run sucursal-dry-run`
 */
import { computeSucursalApprovalHash } from '../../src/cli/gates';
import { parseMessage } from '../../src/core/parse-message';
import { ExecutorError } from '../../src/executor/errors';
import { runDryRun } from '../../src/executor/run';
import { resolveProfileDir } from '../../src/executor/session';

/**
 * Fictional message (R11). The postal code and the branch name are the real,
 * observed CP 1419 values (plan §4c: 13 options for that CP, `Villa Devoto
 * (Av Beiro)` among them) because the panel quotes branches per destination;
 * the recipient data is invented.
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
  console.log('MDL Logistics — live sucursal dry run');
  console.log('mode: dry-run (walks the two sucursal screens and STOPS after the branch is selected)');
  console.log('hard rule: "Crear envío" is never clicked, "Comprar" is never clicked');
  console.log(`profile: ${resolveProfileDir()}`);

  const parsed = parseMessage(MESSAGE);
  if (!parsed.ok) {
    console.error('\nREFUSED by the parser; the panel was not opened.');
    for (const missing of parsed.missing) console.error(`  missing: ${missing.label}`);
    for (const invalid of parsed.invalid) console.error(`  invalid: ${invalid.label}: ${invalid.reason}`);
    for (const unknown of parsed.unknownLabels) console.error(`  unknown label: ${unknown}`);
    return 1;
  }
  if (parsed.value.modality !== 'sucursal') {
    console.error('\nREFUSED: this script drives the sucursal journey only.');
    return 1;
  }
  const request = parsed.value;
  const approvedPayloadHash = computeSucursalApprovalHash(request);

  section('Parsed request (fictional data, real branch name)');
  line('zipCode', request.zipCode);
  line('sucursal', request.sucursal);
  line('customer', `${request.customer.name} ${request.customer.lastName ?? ''}`);
  line('box (cm/g/$)', request.box);
  line('approved payload hash', approvedPayloadHash);

  try {
    const result = await runDryRun({ request, approvedPayloadHash });
    if (result.modality !== 'sucursal') {
      console.error('\nFAILED: the executor dispatched a sucursal request to the wrong journey.');
      return 1;
    }

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
    for (const option of result.journey.carrier.diagnostics) {
      console.log(
        `    radio [${option.index}] group=${option.group} disabled=${option.disabled} checked=${option.checked} visible=${option.visible} name=${JSON.stringify(option.accessibleName)}`,
      );
    }
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

    section('Run report');
    line('stoppedAt', result.stoppedAt);
    line('report', result.reportPath);
    line('startedAt', result.startedAt);
    line('finishedAt', result.finishedAt);

    if (!result.formMatchesApproval || result.mismatches.length > 0) {
      console.error('\nFAILED: the panel readback does not match the approved payload.');
      return 1;
    }

    console.log(
      '\nSTOPPED AFTER THE BRANCH SELECTION: "Crear envío" was not clicked, so no shipment was created and no label was purchased.',
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

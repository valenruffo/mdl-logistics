/**
 * LIVE dry run against the real Envío Nube panel (not part of `npm test`).
 *
 * Why it is not in `npm test`: it needs the live panel, a human-prepared logged-in
 * browser profile, and it drives a real shipment journey. Core tests stay
 * offline and deterministic.
 *
 * What it asserts, in order: screen 1 units are cm/g before anything is written,
 * `Continuar` becomes enabled (a real validity precondition), the panel route
 * advances screen by screen, the province option exists and reads back with the
 * approved name, and finally the summary heading, `Paso 4 de 4` badge and the
 * three cards.
 *
 * What it never does: click `Crear envío` or `Comprar`. The run stops on the
 * summary. Nothing is created and nothing is purchased.
 *
 * Run: `npm run dry-run`
 */
import { CARRIER_NAME } from '../../src/core/carrier';
import { parseMessage } from '../../src/core/parse-message';
import { approvalPayloadFromRequest, hashApprovalPayload } from '../../src/executor/approval';
import { ExecutorError } from '../../src/executor/errors';
import { runDryRun } from '../../src/executor/run';
import { resolveProfileDir } from '../../src/executor/session';

/**
 * Fictional message (R11/R17). The postal code is a real CABA code because the panel
 * quotes carriers per destination and a fake code yields no service at all; the
 * recipient, street, building data and city are invented. `Ciudad` has no existence
 * validator in the panel (operator-confirmed), so an invented locality is fine.
 */
const MESSAGE = [
  '*MDL - Datos de envío*',
  '',
  '*Destino*',
  '*Código postal*: 1419',
  '*Provincia*: Ciudad Autónoma de Buenos Aires (CABA)',
  '*Ciudad*: Villa Ejemplo',
  '*Calle*: Calle Falsa',
  '*Número*: 742',
  '*Departamento*: 2b',
  '*Barrio*: Villa Ejemplo',
  '',
  '*Datos del destinatario*',
  '*Nombre completo*: prueba automatica',
].join('\n');

function line(label: string, value: unknown): void {
  console.log(`  ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

function compact(text: string | null, limit = 700): string {
  if (text === null) return '(not read)';
  return text.replace(/\s+/g, ' ').trim().slice(0, limit);
}

async function main(): Promise<number> {
  console.log('MDL Logistics — live dry run');
  console.log('mode: dry-run (walks screens 1-4 and STOPS on the summary)');
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

  const request = parsed.value;

  /**
   * Stand-in for the approval artifact: no preview module exists yet, so the hash
   * is computed from the parsed request with the same canonicalizer the executor
   * uses on the readback. When the preview lands, this value comes from the
   * operator's approval instead.
   */
  const approvedPayloadHash = hashApprovalPayload(approvalPayloadFromRequest(request, CARRIER_NAME));

  section('Parsed request (fictional data)');
  line('zipCode', request.zipCode);
  line('province', `${request.address.province.name} (${request.address.province.code})`);
  line('city', request.address.city);
  line('address', `${request.address.address} ${request.address.number}, ${request.address.complement ?? '-'}`);
  line('neighborhood', request.address.neighborhood);
  line('customer', `${request.customer.name} ${request.customer.lastName ?? ''}`.trim());
  line('box (cm/g)', request.box);
  line('approved payload hash', approvedPayloadHash);

  try {
    const result = await runDryRun({ request, approvedPayloadHash });

    section('Screen 1 — Calcular costo de envío (read back from the panel)');
    line('frame url', result.journey.cost.url);
    line('units', result.journey.cost.units);
    line('zipCode', result.journey.cost.zipCode);
    line('box.height', result.journey.cost.height);
    line('box.width', result.journey.cost.width);
    line('box.depth', result.journey.cost.depth);
    line('box.weight', result.journey.cost.weight);
    line('declaredValue', result.journey.cost.declaredValue);
    line('Continuar enabled before advancing', result.journey.cost.continueEnabled);

    section('Screen 2 — Seleccionar medio de envío (read back from the panel)');
    line('frame url', result.journey.carrier.url);
    line('offered carriers', result.journey.carrier.offeredOptions);
    for (const option of result.journey.carrier.diagnostics) {
      console.log(
        `    radio [${option.index}] group=${option.group} disabled=${option.disabled} checked=${option.checked} visible=${option.visible} name=${JSON.stringify(option.accessibleName)}`,
      );
    }
    line('selected', `${result.journey.carrier.selectedName} (checked: ${result.journey.carrier.checked})`);
    line('selected card', result.journey.carrier.panelName);

    section('Screen 3 — Completar datos del destinatario (read back from the panel)');
    line('frame url', result.journey.recipient.url);
    line('province', `${result.journey.recipient.province.text} (value: ${result.journey.recipient.province.value})`);
    line('city', result.journey.recipient.city);
    line('address', result.journey.recipient.address);
    line('number', result.journey.recipient.number);
    line('complement', result.journey.recipient.complement);
    line('neighborhood', result.journey.recipient.neighborhood);
    line('name', result.journey.recipient.name);
    line('lastName', result.journey.recipient.lastName);
    line('Continuar enabled before advancing (screen 3)', result.journey.recipient.continueEnabled);

    section('Screen 4 — Resumen del envío (terminal state of this run)');
    line('frame url (summary URL was never captured)', result.journey.summary.url);
    line('heading', result.journey.summary.heading);
    line('step badge', result.journey.summary.stepBadge);
    for (const card of result.journey.summary.cards) {
      line(`card "${card.title}"`, card.present ? compact(card.text) : 'MISSING');
    }
    line('"Crear envío" visible (never clicked)', result.journey.summary.createButtonVisible);

    section('Panel readback vs approved payload');
    line('approved payload hash', result.approvedPayloadHash);
    line('form payload hash', result.formPayloadHash);
    line('form matches approval', result.formMatchesApproval);
    line('field mismatches', result.mismatches.length);
    for (const mismatch of result.mismatches) console.log(`    - ${mismatch}`);

    section('Run report');
    line('report', result.reportPath);
    line('startedAt', result.startedAt);
    line('finishedAt', result.finishedAt);

    if (!result.formMatchesApproval || result.mismatches.length > 0) {
      console.error('\nFAILED: the panel readback does not match the approved payload.');
      return 1;
    }

    console.log('\nSTOPPED ON THE SUMMARY: "Crear envío" was not clicked, so no shipment was created and no label was purchased.');
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

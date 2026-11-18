/**
 * The sucursal slice: parser, config, preview and refusals.
 *
 * The frozen message format is the contract: `Modalidad` switches the required
 * field set, its **absence** is a format-version rule (old format = domicilio,
 * never an inference), and wrong-format data is a rejection naming it — never
 * silently dropped (R12). The sucursal run itself is refused everywhere in this
 * slice: the executor comes later, after a DOM discovery pass.
 *
 * Everything is offline and fictional (R11): invented messages, no browser.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { DEFAULT_CONFIG } from '../../src/core/config';
import { MESSAGE_LABELS } from '../../src/core/labels';
import { parseMessage } from '../../src/core/parse-message';
import {
  PANEL_ANCHORS,
  type AnyShipmentRequest,
  type ParseFailure,
  type ParseResult,
  type ShipmentRequest,
  type SucursalShipmentRequest,
} from '../../src/core/types';
import { SUCURSAL_RUN_REFUSAL, analyzeMessage, runAttempt, type ActionDeps, type UiExecutor } from '../../src/ui/actions';
import {
  SUCURSAL_ANCHOR_PENDING,
  formFieldsForBothModalities,
  formFieldsFromRequest,
  formValuesFromFields,
  requestFromForm,
} from '../../src/ui/form';
import {
  HAPPY_MESSAGE,
  MODALITY_DOMICILE_MESSAGE,
  SUCURSAL_MESSAGE,
  withoutLine,
} from './fixtures';

// ----------------------------------------------------------------- helpers

function expectOk(result: ParseResult): AnyShipmentRequest {
  assert.equal(result.ok, true, `expected the message to be accepted, got ${JSON.stringify(result)}`);
  if (!result.ok) throw new Error('unreachable');
  return result.value;
}

function expectFailure(result: ParseResult): ParseFailure {
  assert.equal(result.ok, false, `expected the message to be rejected, got ${JSON.stringify(result)}`);
  if (result.ok) throw new Error('unreachable');
  return result;
}

function missingFields(failure: ParseFailure): string[] {
  return failure.missing.map((issue) => issue.field);
}

function invalidFields(failure: ParseFailure): string[] {
  return failure.invalid.map((issue) => issue.field);
}

function expectSucursal(value: AnyShipmentRequest): SucursalShipmentRequest {
  assert.equal(value.modality, 'sucursal');
  if (value.modality !== 'sucursal') throw new Error('unreachable');
  return value;
}

function expectDomicilio(value: AnyShipmentRequest): ShipmentRequest {
  assert.equal(value.modality, 'domicilio');
  if (value.modality !== 'domicilio') throw new Error('unreachable');
  return value;
}

/** A no-op executor: a refusal must fire before the executor is ever touched. */
function forbiddenExecutor(): UiExecutor {
  return {
    runDryRun: async () => {
      throw new Error('the executor must never be reached in this test');
    },
    runCreate: async () => {
      throw new Error('the executor must never be reached in this test');
    },
  };
}

const DEPS: ActionDeps = { executor: forbiddenExecutor(), recordDir: '/nonexistent-run-records' };

// ------------------------------------------------------- 1. the parser rules

test('old format without Modalidad parses exactly as today, as domicilio (regression)', () => {
  const value = expectDomicilio(expectOk(parseMessage(HAPPY_MESSAGE)));

  assert.equal(value.zipCode, '1901');
  assert.equal(value.address.city, 'Villa Ejemplo');
  assert.equal(value.address.address, 'Calle Falsa');
  assert.equal(value.customer.name, 'Juan');
  assert.deepEqual(value.box, DEFAULT_CONFIG.package);
  assert.equal(value.box.declaredValueArs, undefined, 'domicilio keeps its optional empty declared value');
});

test('new-format domicilio with the Modalidad line parses like the old one', () => {
  const value = expectDomicilio(expectOk(parseMessage(MODALITY_DOMICILE_MESSAGE)));

  assert.equal(value.zipCode, '1901');
  assert.equal(value.address.province.code, 'C');
  assert.equal(value.address.neighborhood, 'Villa Ejemplo');
  assert.equal(value.customer.lastName, 'Perez');
  // The declared-value policy is per modality: domicilio stays optional empty.
  assert.equal(value.box.declaredValueArs, undefined);
});

test('sucursal happy path: every frozen-format field is parsed, nothing invented', () => {
  const value = expectSucursal(expectOk(parseMessage(SUCURSAL_MESSAGE)));

  assert.equal(value.zipCode, '1419');
  assert.equal(value.sucursal, 'Sucursal Villa Ejemplo - Av. Falsa 123');
  assert.deepEqual(value.customer, {
    name: 'Juan',
    lastName: 'Pérez',
    email: 'juan@ejemplo.com',
    phone: '1122334455',
  });
  assert.deepEqual(value.derived, []);
});

test('Sucursal (nombre) is free text: trimmed and whitespace-collapsed, nothing else', () => {
  const message = SUCURSAL_MESSAGE.replace(
    'Sucursal (nombre): Sucursal Villa Ejemplo - Av. Falsa 123',
    'Sucursal (nombre):   Sucursal   Villa  Ejemplo (Av. Beiró)   ',
  );

  assert.equal(expectSucursal(expectOk(parseMessage(message))).sucursal, 'Sucursal Villa Ejemplo (Av. Beiró)');
});

test('optional sucursal fields: absent Email/Teléfono/Apellido become null, never defaults', () => {
  // The frozen format with the optional lines simply absent.
  const message = [
    '*MDL - Datos de envío*',
    '',
    'Modalidad: sucursal',
    'Sucursal (nombre): Sucursal Villa Ejemplo - Av. Falsa 123',
    '*Código postal*: 1419',
    '',
    '*Datos del destinatario*',
    '*Nombre*: Juan',
  ].join('\n');

  const value = expectSucursal(expectOk(parseMessage(message)));

  assert.deepEqual(value.customer, { name: 'Juan', lastName: null, email: null, phone: null });
});

test('sucursal requires Sucursal (nombre), Código postal and Nombre; all reported at once', () => {
  const message = [
    '*MDL - Datos de envío*',
    '',
    'Modalidad: sucursal',
    '',
    '*Datos del destinatario*',
    '*Apellido*: Pérez',
  ].join('\n');

  const failure = expectFailure(parseMessage(message));

  assert.deepEqual(missingFields(failure).sort(), ['nombre', 'sucursal', 'zipCode']);
  // The sucursal-specific fields have no observed panel anchor yet (the
  // executor slice decides them); zipCode keeps the one §4c observed.
  const missingByField = new Map(failure.missing.map((issue) => [issue.field, issue]));
  assert.equal(missingByField.get('sucursal')?.anchor, undefined);
  assert.equal(missingByField.get('nombre')?.anchor, undefined);
  assert.equal(missingByField.get('zipCode')?.anchor, PANEL_ANCHORS.zipCode);
});

test('an empty Sucursal (nombre) counts as missing, not as an invented default', () => {
  const failure = expectFailure(parseMessage(SUCURSAL_MESSAGE.replace('Sucursal (nombre): Sucursal Villa Ejemplo - Av. Falsa 123', 'Sucursal (nombre):')));

  assert.deepEqual(missingFields(failure), ['sucursal']);
});

test('sucursal with domicilio address fields present is a rejection naming them (R12)', () => {
  const message = [
    '*MDL - Datos de envío*',
    '',
    'Modalidad: sucursal',
    'Sucursal (nombre): Sucursal Villa Ejemplo',
    '*Código postal*: 1419',
    '',
    '*Destino*',
    '*Provincia*: Ciudad Autónoma de Buenos Aires (CABA)',
    '*Ciudad*: Villa Ejemplo',
    '*Calle*: Calle Falsa',
    '*Número*: 742',
    '*Departamento*: 2b',
    '*Barrio*: Villa Ejemplo',
    '',
    '*Datos del destinatario*',
    '*Nombre*: Juan',
  ].join('\n');

  const failure = expectFailure(parseMessage(message));

  assert.deepEqual(invalidFields(failure).sort(), ['address', 'city', 'complement', 'neighborhood', 'number', 'province']);
  for (const label of ['Provincia', 'Ciudad', 'Calle', 'Número', 'Departamento', 'Barrio']) {
    assert.ok(
      failure.invalid.some((issue) => issue.label === label && /domicilio format/.test(issue.reason)),
      `expected a rejection naming ${label}`,
    );
  }
});

test('sucursal with Nombre completo instead of Nombre/Apellido is a rejection naming it', () => {
  const message = SUCURSAL_MESSAGE
    .replace('*Nombre*: Juan\n*Apellido*: Pérez', '*Nombre completo*: juan perez');

  const failure = expectFailure(parseMessage(message));

  assert.ok(invalidFields(failure).includes('fullName'));
  assert.match(failure.invalid[0]?.reason ?? '', /sucursal|Nombre completo/);
});

test('domicilio message carrying sucursal labels is a rejection naming them', () => {
  const message = [
    ...HAPPY_MESSAGE.split('\n'),
    'Email: juan@ejemplo.com',
    'Teléfono: 1122334455',
  ].join('\n');

  const failure = expectFailure(parseMessage(message));

  assert.deepEqual(invalidFields(failure).sort(), ['email', 'telefono']);
  assert.ok(failure.invalid.every((issue) => /sucursal format/.test(issue.reason)));
});

test('a bad Modalidad value is a rejection naming the two accepted values', () => {
  const failure = expectFailure(parseMessage(MODALITY_DOMICILE_MESSAGE.replace('Modalidad: domicilio', 'Modalidad: correo')));

  assert.deepEqual(invalidFields(failure), ['modalidad']);
  assert.deepEqual(failure.missing, []);
  assert.match(failure.invalid[0]?.reason ?? '', /domicilio/);
  assert.match(failure.invalid[0]?.reason ?? '', /sucursal/);
  assert.equal('value' in failure, false, 'a rejection must not carry a payload');
});

test('Modalidad tolerates case and surrounding whitespace, never a different word', () => {
  assert.equal(expectOk(parseMessage(MODALITY_DOMICILE_MESSAGE.replace('Modalidad: domicilio', 'Modalidad:  DOMICILIO '))).modality, 'domicilio');
  assert.equal(expectOk(parseMessage(SUCURSAL_MESSAGE.replace('Modalidad: sucursal', 'modalidad: SUCURSAL'))).modality, 'sucursal');
});

test('a sucursal postal code is validated like any other', () => {
  const value = expectSucursal(
    expectOk(parseMessage(SUCURSAL_MESSAGE.replace('*Código postal*: 1419', '*Código postal*: b1419abc'))),
  );
  assert.equal(value.zipCode, 'B1419ABC');

  const failure = expectFailure(parseMessage(SUCURSAL_MESSAGE.replace('*Código postal*: 1419', '*Código postal*: nope')));
  assert.deepEqual(invalidFields(failure), ['zipCode']);
});

test('sucursal carries the declared-value default 100000; domicilio does not', () => {
  assert.equal(expectSucursal(expectOk(parseMessage(SUCURSAL_MESSAGE))).box.declaredValueArs, 100000);
  assert.equal(expectDomicilio(expectOk(parseMessage(HAPPY_MESSAGE))).box.declaredValueArs, undefined);
});

test('the message label table stays the single source of truth for the new labels', () => {
  assert.equal(MESSAGE_LABELS.fields.modalidad, 'Modalidad');
  assert.equal(MESSAGE_LABELS.fields.sucursal, 'Sucursal (nombre)');
  assert.equal(MESSAGE_LABELS.fields.nombre, 'Nombre');
  assert.equal(MESSAGE_LABELS.fields.apellido, 'Apellido');
  assert.equal(MESSAGE_LABELS.fields.email, 'Email');
  assert.equal(MESSAGE_LABELS.fields.telefono, 'Teléfono');
});

// ------------------------------------------------ 2. the editable preview

test('analyze: a sucursal message yields the sucursal field set, with no address group', () => {
  const analyzed = analyzeMessage(SUCURSAL_MESSAGE);
  assert.equal(analyzed.status, 'parsed');
  if (analyzed.status !== 'parsed') throw new Error('unreachable');

  assert.equal(analyzed.modalidad, 'sucursal');
  const keys = analyzed.fields.map((field) => field.key);
  assert.deepEqual(keys, [
    'modalidad',
    'zipCode',
    'sucursal',
    'name',
    'lastName',
    'email',
    'telefono',
    'height',
    'width',
    'depth',
    'weight',
    'declaredValue',
  ]);
  assert.equal(keys.includes('province'), false, 'the address group is hidden in sucursal mode');
  assert.equal(keys.includes('city'), false);

  const sucursalField = analyzed.fields.find((field) => field.key === 'sucursal');
  assert.ok(sucursalField);
  assert.equal(sucursalField.panelField, SUCURSAL_ANCHOR_PENDING, 'the real anchors belong to the executor slice');
});

test('analyze: the declared value is prefilled with 100000, shown as an editable input', () => {
  const analyzed = analyzeMessage(SUCURSAL_MESSAGE);
  assert.equal(analyzed.status, 'parsed');
  if (analyzed.status !== 'parsed') throw new Error('unreachable');

  const declared = analyzed.fields.find((field) => field.key === 'declaredValue');
  assert.ok(declared);
  assert.equal(declared.value, '100000');
  assert.equal(declared.kind, 'measure', 'a measure renders as a plain editable input, not a select');
  assert.equal(declared.required, true, 'sucursal declares it required-with-default');
});

test('analyze: the Modalidad control is the first field, rendered as a segmented pair', () => {
  const analyzed = analyzeMessage(SUCURSAL_MESSAGE);
  assert.equal(analyzed.status, 'parsed');
  if (analyzed.status !== 'parsed') throw new Error('unreachable');

  const modalidadField = analyzed.fields[0];
  assert.ok(modalidadField);
  assert.equal(modalidadField.key, 'modalidad');
  assert.equal(modalidadField.kind, 'modalidad');
  assert.equal(modalidadField.value, 'sucursal');
});

test('analyze: both modality field lists are returned, so a switch re-derives without a parse', () => {
  const analyzed = analyzeMessage(HAPPY_MESSAGE);
  assert.equal(analyzed.status, 'parsed');
  if (analyzed.status !== 'parsed') throw new Error('unreachable');

  assert.equal(analyzed.modalidad, 'domicilio');
  assert.deepEqual(Object.keys(analyzed.fieldsByModalidad).sort(), ['domicilio', 'sucursal']);

  const domicilioKeys = analyzed.fieldsByModalidad.domicilio.map((field) => field.key);
  const sucursalKeys = analyzed.fieldsByModalidad.sucursal.map((field) => field.key);
  assert.ok(domicilioKeys.includes('province') && domicilioKeys.includes('city') && domicilioKeys.includes('address'));
  assert.equal(sucursalKeys.includes('province'), false);
  assert.ok(sucursalKeys.includes('sucursal') && sucursalKeys.includes('zipCode'));

  // Nothing is invented on a switch: the domicilio message carries no sucursal
  // data, so the sucursal field stays empty for the operator, while the
  // declared value takes the sucursal policy (prefilled, editable).
  const sucursalField = analyzed.fieldsByModalidad.sucursal.find((field) => field.key === 'sucursal');
  assert.equal(sucursalField?.value, '');
  const declared = analyzed.fieldsByModalidad.sucursal.find((field) => field.key === 'declaredValue');
  assert.equal(declared?.value, '100000');
  const domicilioDeclared = analyzed.fieldsByModalidad.domicilio.find((field) => field.key === 'declaredValue');
  assert.equal(domicilioDeclared?.value, '', 'domicilio keeps its optional empty declared value');

  // And the reverse: a sucursal parse prefills the sucursal list from the
  // message and leaves the domicilio address group empty, not guessed.
  const sucursalAnalyzed = analyzeMessage(SUCURSAL_MESSAGE);
  assert.equal(sucursalAnalyzed.status, 'parsed');
  if (sucursalAnalyzed.status !== 'parsed') throw new Error('unreachable');
  const domicilioList = sucursalAnalyzed.fieldsByModalidad.domicilio;
  assert.equal(domicilioList.find((field) => field.key === 'province')?.value, '');
  assert.equal(domicilioList.find((field) => field.key === 'zipCode')?.value, '1419');
  assert.equal(domicilioList.find((field) => field.key === 'name')?.value, 'Juan');
});

test('formFieldsFromRequest keeps the observed panel anchors of the domicilio shape intact', () => {
  const parsed = parseMessage(HAPPY_MESSAGE);
  assert.ok(parsed.ok);
  const fields = formFieldsFromRequest(parsed.value);
  const panelFieldByLabel = new Map(fields.map((field) => [field.label, field.panelField]));
  assert.equal(panelFieldByLabel.get('Código postal'), 'zipCode');
  assert.equal(panelFieldByLabel.get('Provincia'), 'address.province');
  assert.equal(panelFieldByLabel.get('Calle'), 'address.address');
  assert.equal(panelFieldByLabel.get('Nombre'), 'customer.name');
});

test('requestFromForm rebuilds a sucursal request from the posted values', () => {
  const analyzed = analyzeMessage(SUCURSAL_MESSAGE);
  assert.equal(analyzed.status, 'parsed');
  if (analyzed.status !== 'parsed') throw new Error('unreachable');

  const built = requestFromForm(formValuesFromFields(analyzed.fieldsByModalidad.sucursal));
  assert.ok(built.ok);
  if (!built.ok) throw new Error('unreachable');

  const value = expectSucursal(built.value);
  assert.equal(value.zipCode, '1419');
  assert.equal(value.sucursal, 'Sucursal Villa Ejemplo - Av. Falsa 123');
  assert.equal(value.box.declaredValueArs, 100000);
  assert.deepEqual(value.customer, { name: 'Juan', lastName: 'Pérez', email: 'juan@ejemplo.com', phone: '1122334455' });
});

test('requestFromForm refuses a sucursal form with a cleared declared value or blank sucursal', () => {
  const analyzed = analyzeMessage(SUCURSAL_MESSAGE);
  assert.equal(analyzed.status, 'parsed');
  if (analyzed.status !== 'parsed') throw new Error('unreachable');

  const values = formValuesFromFields(analyzed.fieldsByModalidad.sucursal);

  const noDeclared = requestFromForm({ ...values, declaredValue: '' });
  assert.equal(noDeclared.ok, false);
  if (noDeclared.ok) throw new Error('unreachable');
  assert.ok(noDeclared.errors.some((issue) => issue.field === 'declaredValue'));

  const noSucursal = requestFromForm({ ...values, sucursal: '' });
  assert.equal(noSucursal.ok, false);
  if (noSucursal.ok) throw new Error('unreachable');
  assert.ok(noSucursal.errors.some((issue) => issue.field === 'sucursal'));

  const badModalidad = requestFromForm({ ...values, modalidad: 'correo' });
  assert.equal(badModalidad.ok, false);
  if (badModalidad.ok) throw new Error('unreachable');
  assert.ok(badModalidad.errors.some((issue) => issue.field === 'modalidad'));
});

test('requestFromForm keeps the domicilio path working, with or without a Modalidad value', () => {
  const analyzed = analyzeMessage(HAPPY_MESSAGE);
  assert.equal(analyzed.status, 'parsed');
  if (analyzed.status !== 'parsed') throw new Error('unreachable');

  const values = formValuesFromFields(analyzed.fieldsByModalidad.domicilio);
  assert.ok(requestFromForm(values).ok);
  assert.ok(requestFromForm({ ...values, modalidad: '' }).ok, 'absence of Modalidad is the old format');
});

test('both modality lists agree on the package defaults, in centimetres and grams', () => {
  const both = formFieldsForBothModalities(expectOk(parseMessage(SUCURSAL_MESSAGE)), DEFAULT_CONFIG);
  for (const list of [both.domicilio, both.sucursal]) {
    assert.equal(list.find((field) => field.key === 'weight')?.value, String(DEFAULT_CONFIG.package.weightG));
    assert.equal(list.find((field) => field.key === 'height')?.value, String(DEFAULT_CONFIG.package.heightCm));
  }
});

// ------------------------------------------------------- 3. the run refusals

test('a sucursal create run is refused before anything is hashed or touched', async () => {
  const analyzed = analyzeMessage(SUCURSAL_MESSAGE);
  assert.equal(analyzed.status, 'parsed');
  if (analyzed.status !== 'parsed') throw new Error('unreachable');

  const form = formValuesFromFields(analyzed.fieldsByModalidad.sucursal);
  const response = await runAttemptWith(form, 'create');

  assert.deepEqual(response, {
    status: 'refused',
    stage: 'sucursal-not-implemented',
    reason: 'la carga de envíos a sucursal todavía no está implementada en esta versión',
    details: [],
  });
});

test('a sucursal dry run is refused with the same wording: the UI stays honest', async () => {
  const analyzed = analyzeMessage(SUCURSAL_MESSAGE);
  assert.equal(analyzed.status, 'parsed');
  if (analyzed.status !== 'parsed') throw new Error('unreachable');

  const form = formValuesFromFields(analyzed.fieldsByModalidad.sucursal);
  const response = await runAttemptWith(form, 'dry-run');

  assert.equal(response.status, 'refused');
  if (response.status !== 'refused') throw new Error('unreachable');
  assert.equal(response.reason, SUCURSAL_RUN_REFUSAL);
});

test('the refusal never reaches the injected executor', async () => {
  let touched = false;
  const deps: ActionDeps = {
    executor: {
      runDryRun: async () => {
        touched = true;
        throw new Error('unreachable');
      },
      runCreate: async () => {
        touched = true;
        throw new Error('unreachable');
      },
    },
    recordDir: '/nonexistent-run-records',
  };
  const analyzed = analyzeMessage(SUCURSAL_MESSAGE);
  assert.equal(analyzed.status, 'parsed');
  if (analyzed.status !== 'parsed') throw new Error('unreachable');

  await runAttemptWith(formValuesFromFields(analyzed.fieldsByModalidad.sucursal), 'create', deps);
  assert.equal(touched, false);
});

async function runAttemptWith(
  form: Record<string, string>,
  mode: 'create' | 'dry-run',
  deps: ActionDeps = DEPS,
): Promise<unknown> {
  return runAttempt({ message: SUCURSAL_MESSAGE, form, mode }, deps);
}

// ------------------------------------------------------------ 4. the CLI refusal

test('the CLI refuses a sucursal message before any payload is hashed', async () => {
  const source = await readFile(new URL('../../src/cli/ship.ts', import.meta.url), { encoding: 'utf8' });

  const refusalIndex = source.indexOf(
    'REFUSED: este mensaje es de envío a sucursal y la carga a sucursal todavía no está implementada en esta versión',
  );
  assert.ok(refusalIndex > 0, 'the CLI carries the exact sucursal refusal wording');

  const narrowingIndex = source.indexOf("request.modality === 'sucursal'");
  assert.ok(narrowingIndex > 0, 'the CLI narrows the parsed value by modality');
  const firstHashUse = source.indexOf('approvalPayloadFromRequest(request, CARRIER_NAME)');
  assert.ok(firstHashUse > narrowingIndex, 'nothing is hashed before the sucursal refusal');
  assert.ok(refusalIndex < firstHashUse, 'the refusal sits before any domicilio payload is built');
});

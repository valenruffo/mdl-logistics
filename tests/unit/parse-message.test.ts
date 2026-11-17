import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_CONFIG } from '../../src/core/config';
import { MESSAGE_LABELS } from '../../src/core/labels';
import { parseMessage } from '../../src/core/parse-message';
import { PANEL_ANCHORS, type ParseFailure, type ParseResult, type ParseWarning, type ShipmentRequest } from '../../src/core/types';
import { HAPPY_MESSAGE, HAPPY_MESSAGE_CRLF, WHATSAPP_MESSAGE, withLines, withoutLine } from './fixtures';

/** Reads every panel anchor out of a parsed request, keyed by the real anchor. */
function readAnchors(request: ShipmentRequest): Record<string, string> {
  return {
    [PANEL_ANCHORS.zipCode]: request.zipCode,
    [PANEL_ANCHORS.province]: request.address.province.code,
    [PANEL_ANCHORS.city]: request.address.city,
    [PANEL_ANCHORS.address]: request.address.address,
    [PANEL_ANCHORS.number]: request.address.number,
    [PANEL_ANCHORS.complement]: request.address.complement ?? '',
    [PANEL_ANCHORS.neighborhood]: request.address.neighborhood,
    [PANEL_ANCHORS.name]: request.customer.name,
    [PANEL_ANCHORS.lastName]: request.customer.lastName ?? '',
  };
}

function expectOk(result: ParseResult): ShipmentRequest {
  return expectSuccess(result).value;
}

function expectSuccess(result: ParseResult): { value: ShipmentRequest; warnings: ParseWarning[] } {
  assert.equal(result.ok, true, `expected the message to be accepted, got ${JSON.stringify(result)}`);
  if (!result.ok) throw new Error('unreachable');
  return result;
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

test('happy path: parses every panel field of the fictional sample message', () => {
  const value = expectOk(parseMessage(HAPPY_MESSAGE));

  assert.equal(value.zipCode, '1901');
  assert.deepEqual(value.address.province, {
    code: 'C',
    name: 'Ciudad Autónoma de Buenos Aires',
  });
  assert.equal(value.address.city, 'Villa Ejemplo');
  assert.equal(value.address.address, 'Calle Falsa');
  assert.equal(value.address.number, '742');
  assert.equal(value.address.complement, '2b');
  assert.equal(value.address.neighborhood, 'Villa Ejemplo');
  assert.equal(value.customer.name, 'Juan');
  assert.equal(value.customer.lastName, 'Perez');
});

test('happy path: produces exactly the nine panel anchors of plan section 4c', () => {
  const anchors = readAnchors(expectOk(parseMessage(HAPPY_MESSAGE)));

  assert.deepEqual(
    Object.keys(PANEL_ANCHORS).map((key) => PANEL_ANCHORS[key as keyof typeof PANEL_ANCHORS]).sort(),
    [
      'address.address',
      'address.city',
      'address.complement',
      'address.neighborhood',
      'address.number',
      'address.province',
      'customer.lastName',
      'customer.name',
      'zipCode',
    ].sort(),
  );
  assert.deepEqual(Object.keys(anchors).sort(), Object.values(PANEL_ANCHORS).map(String).sort());
});

test('happy path: package defaults come from config, in centimetres and grams', () => {
  const value = expectOk(parseMessage(HAPPY_MESSAGE));

  assert.deepEqual(value.box, DEFAULT_CONFIG.package);
  assert.equal(value.box.weightG, DEFAULT_CONFIG.package.weightG);
  assert.equal(value.box.heightCm, DEFAULT_CONFIG.package.heightCm);
  assert.equal(value.box.declaredValueArs, undefined);
});

test('happy path: Barrio is parsed input when the message provides it', () => {
  const { value, warnings } = expectSuccess(parseMessage(HAPPY_MESSAGE));

  assert.equal(value.address.neighborhood, 'Villa Ejemplo');
  assert.ok(
    value.derived.every(
      (d) => !(d.anchor === PANEL_ANCHORS.neighborhood && d.rule === 'neighborhood-from-city'),
    ),
    'a parsed Barrio must not be marked as derived',
  );
  assert.deepEqual(warnings, []);
});

test('happy path: the full name split and the title-case are marked as derivations', () => {
  const value = expectOk(parseMessage(HAPPY_MESSAGE));
  const rules = value.derived.map((d) => `${d.anchor}:${d.rule}`);

  assert.ok(rules.includes(`${PANEL_ANCHORS.name}:full-name-split`));
  assert.ok(rules.includes(`${PANEL_ANCHORS.lastName}:full-name-split`));
  assert.ok(rules.includes(`${PANEL_ANCHORS.name}:title-case`));
  assert.ok(rules.includes(`${PANEL_ANCHORS.lastName}:title-case`));
});

test('happy path: a mixed-case name is kept verbatim and not title-cased twice', () => {
  const message = HAPPY_MESSAGE.replace('Nombre completo: juan perez', 'Nombre completo: Ana Del Valle');
  const value = expectOk(parseMessage(message));

  assert.equal(value.customer.name, 'Ana');
  assert.equal(value.customer.lastName, 'Del Valle');
  assert.ok(value.derived.every((d) => d.rule !== 'title-case'), 'no title-case derivation expected');
});

test('missing postal code: rejection names the missing field and invents nothing', () => {
  const result = parseMessage(withoutLine(HAPPY_MESSAGE, 'Código postal:'));

  assert.equal(result.ok, false);
  const failure = expectFailure(result);
  assert.ok(missingFields(failure).includes('zipCode'));
  assert.deepEqual(failure.missing, [
    { field: 'zipCode', anchor: PANEL_ANCHORS.zipCode, label: MESSAGE_LABELS.fields.zipCode },
  ]);
  assert.deepEqual(failure.invalid, []);
  assert.deepEqual(failure.unknownLabels, []);
  assert.equal('value' in failure, false, 'a rejection must not carry a payload');
});

test('missing number: rejection names the missing field', () => {
  const failure = expectFailure(parseMessage(withoutLine(HAPPY_MESSAGE, 'Número:')));

  assert.deepEqual(failure.missing, [
    { field: 'number', anchor: PANEL_ANCHORS.number, label: MESSAGE_LABELS.fields.number },
  ]);
  assert.deepEqual(failure.invalid, []);
});

test('several missing fields are all reported at once, never short-circuited', () => {
  let message = withoutLine(HAPPY_MESSAGE, 'Código postal:');
  message = withoutLine(message, 'Número:');
  message = withoutLine(message, 'Calle:');

  const failure = expectFailure(parseMessage(message));

  assert.deepEqual(missingFields(failure), ['address', 'number', 'zipCode']);
});

test('ambiguous province "Bs As" is rejected naming both Buenos Aires (B) and Gran Buenos Aires (BX)', () => {
  const message = HAPPY_MESSAGE.replace(
    'Provincia: Ciudad Autónoma de Buenos Aires (CABA)',
    'Provincia: Bs As',
  );

  const failure = expectFailure(parseMessage(message));

  assert.deepEqual(invalidFields(failure), ['province']);
  const issue = failure.invalid[0];
  assert.ok(issue);
  assert.match(issue.reason, /ambig/i);
  assert.match(issue.reason, /Buenos Aires \(B\)/);
  assert.match(issue.reason, /Gran Buenos Aires \(BX\)/);
});

test('unambiguous provinces resolve to their panel code', () => {
  const cases: Array<[string, string]> = [
    ['Buenos Aires', 'B'],
    ['Gran Buenos Aires', 'BX'],
    ['Córdoba', 'X'],
    ['Ciudad Autónoma de Buenos Aires (CABA)', 'C'],
    ['CABA', 'C'],
    ['C.A.B.A.', 'C'],
    ['Capital Federal', 'C'],
    ['tucuman', 'T'],
  ];

  for (const [label, code] of cases) {
    const message = HAPPY_MESSAGE.replace(
      'Provincia: Ciudad Autónoma de Buenos Aires (CABA)',
      `Provincia: ${label}`,
    );
    const value = expectOk(parseMessage(message));
    assert.equal(value.address.province.code, code, `province ${label}`);
  }
});

test('an unmatched province lists the valid option names', () => {
  const message = HAPPY_MESSAGE.replace(
    'Provincia: Ciudad Autónoma de Buenos Aires (CABA)',
    'Provincia: Narnia',
  );

  const failure = expectFailure(parseMessage(message));
  const issue = failure.invalid[0];

  assert.ok(issue);
  assert.equal(issue.field, 'province');
  assert.match(issue.reason, /Buenos Aires \(B\)/);
  assert.match(issue.reason, /Gran Buenos Aires \(BX\)/);
  assert.match(issue.reason, /Tucumán \(T\)/);
});

test('unknown label: rejection, never silently ignored', () => {
  const message = HAPPY_MESSAGE.replace(
    'Barrio: Villa Ejemplo\n',
    'Barrio: Villa Ejemplo\nObservaciones: entregar por la tarde\n',
  );

  const failure = expectFailure(parseMessage(message));

  assert.deepEqual(failure.unknownLabels, ['Observaciones']);
  assert.deepEqual(failure.invalid, []);
});

test('a field that belongs to the other section is rejected', () => {
  const message = HAPPY_MESSAGE.replace(
    'Nombre completo: juan perez',
    'Nombre completo: juan perez\nCalle: Calle Falsa',
  );

  const failure = expectFailure(parseMessage(message));

  assert.ok(failure.invalid.some((issue) => issue.field === 'address'));
  assert.match(failure.invalid[0]?.reason ?? '', /Destino/);
});

test('unknown section heading and its fields are both reported as unknown labels', () => {
  const message = withLines(HAPPY_MESSAGE, ['Datos del pago', 'Monto: 1234']);

  const failure = expectFailure(parseMessage(message));

  assert.deepEqual(failure.unknownLabels, ['Datos del pago', 'Monto']);
});

test('CPA postal code (8 characters) is accepted and normalized to uppercase', () => {
  const value = expectOk(parseMessage(HAPPY_MESSAGE.replace('Código postal: 1901', 'Código postal: b1900abc')));
  assert.equal(value.zipCode, 'B1900ABC');

  const spaced = expectOk(parseMessage(HAPPY_MESSAGE.replace('Código postal: 1901', 'Código postal: B1900 abc')));
  assert.equal(spaced.zipCode, 'B1900ABC');
});

test('an invalid postal code is rejected with a reason', () => {
  const failure = expectFailure(parseMessage(HAPPY_MESSAGE.replace('Código postal: 1901', 'Código postal: ABC12')));

  assert.deepEqual(invalidFields(failure), ['zipCode']);
  const issue = failure.invalid[0];
  assert.ok(issue);
  assert.equal(issue.value, 'ABC12');
  assert.match(issue.reason, /4 digits/);
  assert.match(issue.reason, /CPA/);
});

test('single-token name: name is kept and last name is null (optional in the panel)', () => {
  const value = expectOk(parseMessage(HAPPY_MESSAGE.replace('Nombre completo: juan perez', 'Nombre completo: ana')));

  assert.equal(value.customer.name, 'Ana');
  assert.equal(value.customer.lastName, null);
  assert.ok(
    value.derived.some((d) => d.anchor === PANEL_ANCHORS.name && d.rule === 'full-name-split'),
  );
});

test('CRLF input parses exactly like LF input', () => {
  assert.deepEqual(expectOk(parseMessage(HAPPY_MESSAGE_CRLF)), expectOk(parseMessage(HAPPY_MESSAGE)));
});

test('duplicate section is rejected', () => {
  const message = withLines(HAPPY_MESSAGE, [
    'Destino',
    'Provincia: Córdoba',
    'Código postal: 5000',
    'Ciudad: Villa Ejemplo',
    'Calle: Calle Falsa',
    'Número: 743',
    'Barrio: Villa Ejemplo',
  ]);

  const failure = expectFailure(parseMessage(message));

  assert.ok(failure.invalid.length > 0);
  assert.ok(
    failure.invalid.some((issue) => /duplicate section/i.test(issue.reason)),
    `expected a duplicate-section issue, got ${JSON.stringify(failure.invalid)}`,
  );
});

test('duplicate label is rejected instead of last-write-wins', () => {
  const failure = expectFailure(
    parseMessage(HAPPY_MESSAGE.replace('Ciudad: Villa Ejemplo\nCalle:', 'Ciudad: Villa Ejemplo\nCiudad: Otra Villa\nCalle:')),
  );

  assert.ok(failure.invalid.some((issue) => issue.field === 'city'));
  assert.match(failure.invalid.find((issue) => issue.field === 'city')?.reason ?? '', /duplicate/i);
});

test('labels tolerate accents, mixed case and surrounding whitespace', () => {
  const message = [
    'mdl - datos de envio',
    '',
    'DESTINO',
    'PROVINCIA: buenos aires',
    'codigo postal: 1901',
    'Ciudad:   Villa    Ejemplo  ',
    'CALLE: Calle Falsa',
    'Numero: 742',
    'BARRIO: villa ejemplo',
    '',
    'datos del destinatario',
    'nombre completo: julia ejemplo',
  ].join('\n');

  const value = expectOk(parseMessage(message));

  assert.equal(value.address.province.code, 'B');
  assert.equal(value.address.city, 'Villa Ejemplo');
  assert.equal(value.address.number, '742');
  assert.equal(value.customer.name, 'Julia');
  assert.equal(value.customer.lastName, 'Ejemplo');
});

test('empty required value counts as missing, not as an invented default', () => {
  const failure = expectFailure(parseMessage(HAPPY_MESSAGE.replace('Número: 742', 'Número:')));

  assert.deepEqual(missingFields(failure), ['number']);
});

test('an absent Barrio is derived from Ciudad and marked as derived', () => {
  const { value, warnings } = expectSuccess(parseMessage(withoutLine(HAPPY_MESSAGE, 'Barrio:')));

  assert.equal(value.address.neighborhood, value.address.city);
  assert.ok(
    value.derived.some(
      (d) => d.anchor === PANEL_ANCHORS.neighborhood && d.rule === 'neighborhood-from-city',
    ),
    'a derived neighbourhood must be marked as derived',
  );
  assert.deepEqual(warnings, []);
});

test('a Barrio that differs from Ciudad is kept and warned about, never rejected', () => {
  const { value, warnings } = expectSuccess(
    parseMessage(HAPPY_MESSAGE.replace('Barrio: Villa Ejemplo', 'Barrio: Otro Barrio')),
  );

  assert.equal(value.address.neighborhood, 'Otro Barrio', 'the parsed Barrio must win');
  assert.equal(value.address.city, 'Villa Ejemplo');
  assert.equal(warnings.length, 1);
  const warning = warnings[0];
  assert.ok(warning);
  assert.equal(warning.code, 'neighborhood-differs-from-city');
  assert.equal(warning.field, 'neighborhood');
  assert.match(warning.message, /Otro Barrio/);
  assert.match(warning.message, /Villa Ejemplo/);
});

test('a differing Barrio does not produce a derivation for the neighbourhood', () => {
  const { value } = expectSuccess(
    parseMessage(HAPPY_MESSAGE.replace('Barrio: Villa Ejemplo', 'Barrio: Otro Barrio')),
  );

  assert.ok(
    value.derived.every((d) => d.rule !== 'neighborhood-from-city'),
    'nothing was derived when Barrio was provided',
  );
});

test('a field outside any known section is rejected', () => {
  const message = ['Ciudad: Villa Ejemplo', ...HAPPY_MESSAGE.split('\n')].join('\n');

  const failure = expectFailure(parseMessage(message));

  assert.ok(failure.invalid.some((issue) => /section/i.test(issue.reason)));
});

test('the message label table is the single source of truth', () => {
  assert.equal(MESSAGE_LABELS.fields.zipCode, 'Código postal');
  assert.equal(MESSAGE_LABELS.fields.number, 'Número');
  assert.equal(MESSAGE_LABELS.sections.destination, 'Destino');
  assert.equal(MESSAGE_LABELS.sections.recipient, 'Datos del destinatario');
  assert.equal(MESSAGE_LABELS.title, 'MDL - Datos de envío');
});

test('an empty or garbage message is rejected, listing everything missing', () => {
  const failure = expectFailure(parseMessage('hola que tal'));

  assert.deepEqual(failure.unknownLabels, ['hola que tal']);
  assert.deepEqual(missingFields(failure), ['address', 'city', 'fullName', 'number', 'province', 'zipCode']);
});

test('an absent Departamento is allowed and becomes null (optional in the panel)', () => {
  const value = expectOk(parseMessage(withoutLine(HAPPY_MESSAGE, 'Departamento:')));

  assert.equal(value.address.complement, null);
});

test('a province written without the parenthetical still resolves', () => {
  const value = expectOk(
    parseMessage(
      HAPPY_MESSAGE.replace(
        'Provincia: Ciudad Autónoma de Buenos Aires (CABA)',
        'Provincia: Ciudad Autónoma de Buenos Aires',
      ),
    ),
  );

  assert.equal(value.address.province.code, 'C');
});

test('a 4-digit postal code keeps its leading zeros', () => {
  const value = expectOk(parseMessage(HAPPY_MESSAGE.replace('Código postal: 1901', 'Código postal: 0125')));

  assert.equal(value.zipCode, '0125');
});

test('a rejection carries no payload at all, whatever the failure kind', () => {
  const rejections = [
    withoutLine(HAPPY_MESSAGE, 'Código postal:'),
    HAPPY_MESSAGE.replace('Código postal: 1901', 'Código postal: nope'),
    HAPPY_MESSAGE.replace(
      'Provincia: Ciudad Autónoma de Buenos Aires (CABA)',
      'Provincia: Bs As',
    ),
    HAPPY_MESSAGE.replace('Número: 742', 'Número: 742\nExtra: dato'),
  ];

  for (const message of rejections) {
    const failure = expectFailure(parseMessage(message));
    assert.equal('value' in failure, false, 'a rejection must not carry a payload');
  }
});

// ---------------------------------------------------------------------------
// WhatsApp formatting markers (real message shape)
// ---------------------------------------------------------------------------

test('WhatsApp markers: the full bolded sample parses', () => {
  const { value, warnings } = expectSuccess(parseMessage(WHATSAPP_MESSAGE));

  assert.equal(value.zipCode, '1419');
  assert.deepEqual(value.address.province, {
    code: 'C',
    name: 'Ciudad Autónoma de Buenos Aires',
  });
  assert.equal(value.address.city, 'Villa Ejemplo');
  assert.equal(value.address.address, 'Calle Falsa');
  assert.equal(value.address.number, '742');
  assert.equal(value.address.complement, '2b');
  assert.equal(value.address.neighborhood, 'Villa Ejemplo');
  assert.equal(value.customer.name, 'Juan');
  assert.equal(value.customer.lastName, 'Perez');
  assert.deepEqual(warnings, []);
});

test('WhatsApp markers: a heading wrapped in asterisks still opens its section', () => {
  const message = [
    '*Destino*',
    '*Código postal*: 1419',
    '*Provincia*: Córdoba',
    '*Ciudad*: Villa Ejemplo',
    '*Calle*: Calle Falsa',
    '*Número*: 742',
    '',
    '*Datos del destinatario*',
    '*Nombre completo*: ana',
  ].join('\n');

  const value = expectOk(parseMessage(message));

  assert.equal(value.address.province.code, 'X');
  assert.equal(value.customer.name, 'Ana');
  assert.equal(value.customer.lastName, null);
});

test('WhatsApp markers: a value-edge marker is stripped, an interior one is preserved', () => {
  const message = HAPPY_MESSAGE.replace('Número: 742', 'Número: *742*').replace(
    'Calle: Calle Falsa',
    'Calle: Calle 1*2',
  );

  const value = expectOk(parseMessage(message));

  assert.equal(value.address.number, '742');
  assert.equal(value.address.address, 'Calle 1*2', 'markers inside a value are data, not formatting');
});

test('WhatsApp markers: underscore, tilde and backtick are stripped as well', () => {
  const message = [
    '_MDL - Datos de envío_',
    '*Destino*',
    '_Código postal_: 1419',
    '~Provincia~: Córdoba',
    '`Ciudad`: Villa Ejemplo',
    '~Calle~: Calle Falsa',
    '*Número*: 742',
    '',
    '*Datos del destinatario*',
    '_Nombre completo_: ana',
  ].join('\n');

  const value = expectOk(parseMessage(message));

  assert.equal(value.zipCode, '1419');
  assert.equal(value.address.province.code, 'X');
  assert.equal(value.address.city, 'Villa Ejemplo');
  assert.equal(value.customer.name, 'Ana');
});

test('WhatsApp markers: a genuinely unknown bolded label still rejects', () => {
  const message = HAPPY_MESSAGE.replace(
    'Barrio: Villa Ejemplo\n',
    'Barrio: Villa Ejemplo\n*Observaciones*: entregar por la tarde\n',
  );

  const failure = expectFailure(parseMessage(message));

  assert.deepEqual(failure.unknownLabels, ['Observaciones']);
  assert.deepEqual(failure.invalid, []);
});

test('WhatsApp markers: a bolded duplicate section is still a duplicate', () => {
  const message = withLines(HAPPY_MESSAGE, ['*Destino*']);

  const failure = expectFailure(parseMessage(message));

  assert.ok(
    failure.invalid.some((issue) => /duplicate section/i.test(issue.reason)),
    `expected a duplicate-section issue, got ${JSON.stringify(failure.invalid)}`,
  );
});

test('WhatsApp markers: required fields are still reported missing when bold labels are absent', () => {
  const failure = expectFailure(parseMessage(withoutLine(WHATSAPP_MESSAGE, '*Código postal*:')));

  assert.deepEqual(missingFields(failure), ['zipCode']);
  assert.equal('value' in failure, false);
});

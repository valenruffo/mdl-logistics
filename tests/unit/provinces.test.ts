import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROVINCE_OPTIONS,
  describeProvinceOptions,
  resolveProvince,
  type ProvinceOption,
  type ProvinceResolution,
} from '../../src/core/provinces';

function resolved(input: string): ProvinceOption {
  const result: ProvinceResolution = resolveProvince(input);
  assert.equal(result.ok, true, `expected "${input}" to resolve, got ${JSON.stringify(result)}`);
  if (!result.ok) throw new Error('unreachable');
  return result.value;
}

function rejected(input: string): string {
  const result = resolveProvince(input);
  assert.equal(result.ok, false, `expected "${input}" to be rejected, got ${JSON.stringify(result)}`);
  if (result.ok) throw new Error('unreachable');
  return result.reason;
}

test('the option list mirrors the panel: 24 jurisdictions plus Gran Buenos Aires', () => {
  assert.equal(PROVINCE_OPTIONS.length, 25);

  const codes = PROVINCE_OPTIONS.map((option) => option.code);
  assert.equal(new Set(codes).size, codes.length, 'codes must be unique');
  assert.ok(codes.includes('B'), 'Buenos Aires (B) must exist');
  assert.ok(codes.includes('BX'), 'Gran Buenos Aires (BX) must exist');
  assert.ok(codes.includes('C'), 'Ciudad Autónoma de Buenos Aires (C) must exist');
  assert.ok(codes.includes('T'), 'Tucumán (T) must exist');
});

test('every option name resolves to its own code', () => {
  for (const option of PROVINCE_OPTIONS) {
    assert.deepEqual(resolved(option.name), option);
    assert.deepEqual(resolved(option.name.toLowerCase()), option, option.name);
  }
});

test('parenthetical abbreviations are stripped before matching', () => {
  assert.equal(resolved('Ciudad Autónoma de Buenos Aires (CABA)').code, 'C');
  assert.equal(resolved('Córdoba (CBA)').code, 'X');
  assert.equal(resolved('Mendoza (MZA)').code, 'M');
});

test('CABA, C.A.B.A. and Capital Federal all map to C', () => {
  assert.equal(resolved('CABA').code, 'C');
  assert.equal(resolved('C.A.B.A.').code, 'C');
  assert.equal(resolved('capital federal').code, 'C');
  assert.equal(resolved('  CABA  ').code, 'C');
});

test('Buenos Aires and Gran Buenos Aires stay distinct', () => {
  assert.equal(resolved('Buenos Aires').code, 'B');
  assert.equal(resolved('Gran Buenos Aires').code, 'BX');
});

test('"Bs As" is ambiguous and is rejected naming both options', () => {
  for (const input of ['Bs As', 'BSAS', 'bs as', 'Bs.As.']) {
    const reason = rejected(input);
    assert.match(reason, /ambig/i, input);
    assert.match(reason, /Buenos Aires \(B\)/, input);
    assert.match(reason, /Gran Buenos Aires \(BX\)/, input);
  }
});

test('an unmatched province is rejected listing every valid option name', () => {
  const reason = rejected('Narnia');

  for (const option of PROVINCE_OPTIONS) {
    assert.ok(reason.includes(`${option.name} (${option.code})`), `reason must list ${option.name}`);
  }
});

test('valid option names include accents and are listed in a stable, human-readable form', () => {
  const listing = describeProvinceOptions();

  assert.ok(listing.includes('Río Negro (R)'));
  assert.ok(listing.includes('Tucumán (T)'));
  assert.ok(listing.includes('Gran Buenos Aires (BX)'));
});

test('an empty province is rejected', () => {
  assert.match(rejected('   '), /province/i);
});

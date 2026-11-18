import assert from 'node:assert/strict';
import test from 'node:test';

import { ConfigError, DEFAULT_CONFIG, validateConfig } from '../../src/core/config';

test('the built-in defaults are valid, positive and expressed in cm and grams', () => {
  assert.ok(DEFAULT_CONFIG.package.heightCm > 0);
  assert.ok(DEFAULT_CONFIG.package.widthCm > 0);
  assert.ok(DEFAULT_CONFIG.package.depthCm > 0);
  assert.ok(DEFAULT_CONFIG.package.weightG > 0);
  assert.equal(DEFAULT_CONFIG.package.declaredValueArs, undefined);
});

test('unit suffixes are part of the field names, so grams cannot be read as kilograms', () => {
  const keys = Object.keys(DEFAULT_CONFIG.package);
  assert.ok(keys.includes('weightG'));
  assert.ok(keys.includes('heightCm'));
  assert.ok(keys.includes('widthCm'));
  assert.ok(keys.includes('depthCm'));
});

test('a valid override is accepted and normalized to the declared unit names', () => {
  const config = validateConfig({
    package: { heightCm: 30, widthCm: 20, depthCm: 10, weightG: 750, declaredValueArs: 12500 },
    sucursal: { declaredValueArs: 100000 },
  });

  assert.deepEqual(config.package, {
    heightCm: 30,
    widthCm: 20,
    depthCm: 10,
    weightG: 750,
    declaredValueArs: 12500,
  });
});

test('a zero, negative or non-finite measure is rejected with every issue listed', () => {
  let error: unknown;
  try {
    validateConfig({
      package: { heightCm: 0, widthCm: -5, depthCm: '10', weightG: Number.NaN },
      sucursal: { declaredValueArs: 100000 },
    });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof ConfigError);
  assert.equal(error.issues.length, 4);
  assert.ok(error.issues.some((issue) => issue.includes('heightCm')));
  assert.ok(error.issues.some((issue) => issue.includes('widthCm')));
  assert.ok(error.issues.some((issue) => issue.includes('depthCm')));
  assert.ok(error.issues.some((issue) => issue.includes('weightG')));
});

test('declared value is optional but must be non-negative when present', () => {
  assert.equal(
    validateConfig({
      package: { heightCm: 10, widthCm: 10, depthCm: 10, weightG: 100 },
      sucursal: { declaredValueArs: 100000 },
    }).package.declaredValueArs,
    undefined,
  );

  assert.throws(
    () =>
      validateConfig({
        package: { heightCm: 10, widthCm: 10, depthCm: 10, weightG: 100, declaredValueArs: -1 },
        sucursal: { declaredValueArs: 100000 },
      }),
    ConfigError,
  );
});

test('a config without a package block is rejected', () => {
  assert.throws(() => validateConfig({}), ConfigError);
  assert.throws(() => validateConfig(null), ConfigError);
});

test('unknown extra fields are dropped instead of leaking into the payload', () => {
  const config = validateConfig({
    package: { heightCm: 10, widthCm: 10, depthCm: 10, weightG: 100, weightKg: 1 },
    sucursal: { declaredValueArs: 100000 },
  });

  assert.deepEqual(Object.keys(config.package).sort(), ['depthCm', 'heightCm', 'weightG', 'widthCm']);
});

// ------------------------------------------------- sucursal's declared policy

test('the sucursal default declared value is the operator\'s standing amount, visible in config', () => {
  assert.equal(DEFAULT_CONFIG.sucursal.declaredValueArs, 100000);
  assert.equal(typeof DEFAULT_CONFIG.sucursal.declaredValueArs, 'number');
  // Domicilio keeps its optional, empty declared value.
  assert.equal(DEFAULT_CONFIG.package.declaredValueArs, undefined);
});

test('a config without the sucursal block is rejected: the default is declared, never implied', () => {
  assert.throws(
    () => validateConfig({ package: { heightCm: 10, widthCm: 10, depthCm: 10, weightG: 100 } }),
    ConfigError,
  );
  assert.throws(
    () => validateConfig({ package: { heightCm: 10, widthCm: 10, depthCm: 10, weightG: 100 }, sucursal: {} }),
    ConfigError,
  );
});

test('the sucursal declared value must be a non-negative finite amount in ARS', () => {
  for (const bad of [-1, '100000', Number.NaN, Number.POSITIVE_INFINITY, null]) {
    assert.throws(
      () =>
        validateConfig({
          package: { heightCm: 10, widthCm: 10, depthCm: 10, weightG: 100 },
          sucursal: { declaredValueArs: bad as never },
        }),
      ConfigError,
      `expected ${String(bad)} to be rejected`,
    );
  }

  assert.equal(
    validateConfig({
      package: { heightCm: 10, widthCm: 10, depthCm: 10, weightG: 100 },
      sucursal: { declaredValueArs: 0 },
    }).sucursal.declaredValueArs,
    0,
  );
});

/**
 * The store admin origin is configuration, not a committed fact.
 *
 * Why these tests exist: the repository is published publicly, so a hardcoded
 * store would expose one operator and make the tool useless for any other. The
 * origin must come from `MDL_STORE_ORIGIN`, must be resolved lazily, and must
 * refuse loudly — naming the variable and the expected shape — when it is
 * absent or malformed.
 *
 * Everything here is offline and fictional: no panel, no browser, no network.
 * The origin used in the success paths is an invented `.test` host.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ExecutorError } from '../../src/executor/errors';
import {
  adminAppDashboardUrl,
  resolveStoreOrigin,
  storeAdminUrl,
  STORE_ORIGIN_EXPECTED_SHAPE,
  STORE_ORIGIN_VARIABLE,
} from '../../src/executor/panel';

/** Fictional origin (RFC 6761 `.test`). Never a real store. */
const FICTIONAL_ORIGIN = 'https://tienda-ejemplo.test';
const APP_PATH = '/admin/apps/envionube/ar';

/** Applies an env value for one test and returns the restore function. */
function withOrigin(value: string | undefined): () => void {
  const previous = process.env[STORE_ORIGIN_VARIABLE];
  if (value === undefined) delete process.env[STORE_ORIGIN_VARIABLE];
  else process.env[STORE_ORIGIN_VARIABLE] = value;
  return () => {
    if (previous === undefined) delete process.env[STORE_ORIGIN_VARIABLE];
    else process.env[STORE_ORIGIN_VARIABLE] = previous;
  };
}

/** Runs `action`, requiring it to refuse with an `ExecutorError`. */
function refusal(action: () => unknown): ExecutorError {
  try {
    action();
  } catch (caught) {
    assert.ok(caught instanceof ExecutorError, `expected ExecutorError, got ${String(caught)}`);
    return caught;
  }
  assert.fail('expected a refusal, but the call succeeded');
}

/** Message plus details as one searchable blob. */
function refusalText(error: ExecutorError): string {
  return [error.message, ...error.details].join('\n');
}

test('a configured origin composes both panel URLs from configuration alone', () => {
  const restore = withOrigin(FICTIONAL_ORIGIN);
  try {
    assert.equal(resolveStoreOrigin(), FICTIONAL_ORIGIN);
    assert.equal(storeAdminUrl(), `${FICTIONAL_ORIGIN}${APP_PATH}#/create-single-shipment`);
    assert.equal(adminAppDashboardUrl(), `${FICTIONAL_ORIGIN}${APP_PATH}#/dashboard`);
  } finally {
    restore();
  }
});

test('a trailing slash is normalized away, so composed URLs never double up', () => {
  const restore = withOrigin(`${FICTIONAL_ORIGIN}///`);
  try {
    assert.equal(resolveStoreOrigin(), FICTIONAL_ORIGIN);
    assert.equal(storeAdminUrl(), `${FICTIONAL_ORIGIN}${APP_PATH}#/create-single-shipment`);
    assert.ok(!storeAdminUrl().includes('//admin'));
  } finally {
    restore();
  }
});

test('a missing origin refuses and names both the variable and the expected shape', () => {
  const restore = withOrigin(undefined);
  let error: ExecutorError;
  try {
    error = refusal(() => resolveStoreOrigin());
  } finally {
    restore();
  }

  const text = refusalText(error);
  assert.ok(text.includes(STORE_ORIGIN_VARIABLE), `details must name ${STORE_ORIGIN_VARIABLE}`);
  assert.ok(text.includes(STORE_ORIGIN_EXPECTED_SHAPE), 'details must show the expected shape');
  assert.equal(STORE_ORIGIN_EXPECTED_SHAPE, 'https://<store>.mitiendanube.com');
});

test('an empty or whitespace-only origin is treated as absent', () => {
  for (const value of ['', '   ']) {
    const restore = withOrigin(value);
    try {
      const error = refusal(() => resolveStoreOrigin());
      const text = refusalText(error);
      assert.ok(text.includes(STORE_ORIGIN_VARIABLE));
      assert.ok(text.includes(STORE_ORIGIN_EXPECTED_SHAPE));
    } finally {
      restore();
    }
  }
});

test('a malformed origin is rejected, including a bare host with no scheme', () => {
  const malformed = [
    'tienda-ejemplo.test',
    'http://tienda-ejemplo.test',
    'https://',
    'https://tienda-ejemplo.test/admin',
    'https://tienda-ejemplo.test?query=1',
    'https://tienda-ejemplo.test#fragment',
    'https://user:secret@tienda-ejemplo.test',
    'https://tienda ejemplo.test',
  ];

  for (const value of malformed) {
    const restore = withOrigin(value);
    try {
      const error = refusal(() => resolveStoreOrigin());
      const text = refusalText(error);
      assert.ok(
        text.includes(STORE_ORIGIN_VARIABLE) && text.includes(STORE_ORIGIN_EXPECTED_SHAPE),
        `refusal for ${JSON.stringify(value)} must name the variable and the expected shape`,
      );
    } finally {
      restore();
    }
  }
});

test('importing the module never requires configuration; resolution happens on demand', async () => {
  const restore = withOrigin(undefined);
  try {
    const panel = await import('../../src/executor/panel');

    // The module exposes functions, not eagerly composed URL constants.
    assert.equal(typeof panel.resolveStoreOrigin, 'function');
    assert.equal(typeof panel.storeAdminUrl, 'function');
    assert.equal(typeof panel.adminAppDashboardUrl, 'function');
    for (const formerConstant of ['STORE_ADMIN_ORIGIN', 'STORE_ADMIN_URL', 'ADMIN_APP_DASHBOARD_URL']) {
      assert.ok(!(formerConstant in panel), `${formerConstant} must no longer be a module constant`);
    }

    // Still no configuration: the URL is refused only when actually needed.
    assert.throws(() => panel.storeAdminUrl(), ExecutorError);

    process.env[STORE_ORIGIN_VARIABLE] = FICTIONAL_ORIGIN;
    assert.equal(panel.storeAdminUrl(), `${FICTIONAL_ORIGIN}${APP_PATH}#/create-single-shipment`);
  } finally {
    restore();
  }
});

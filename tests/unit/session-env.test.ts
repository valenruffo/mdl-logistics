/**
 * The runtime switches that make the executor usable on a server.
 *
 * Why these tests exist: a VPS has no display, and the logged-in session is
 * transferred as a Playwright `storageState` file instead of a browser profile.
 * Both switches are optional, and a misread one is the difference between a
 * working deployment and a browser that cannot start or a session that is
 * silently ignored. So the contract pinned here is:
 *
 *  - `MDL_HEADLESS` defaults to `false`, accepts exactly `true`/`false`, and
 *    refuses anything else (the old truthy `1` included);
 *  - `MDL_STORAGE_STATE` absent means today's persistent profile, untouched;
 *    present means a non-persistent context seeded from that file, still honouring
 *    `MDL_HEADLESS`;
 *  - a storage state path that is not a real file is refused, never launched;
 *  - resolving the switches never launches a browser and never touches the network.
 *
 * The file used as a "valid" storage state is an invented, empty JSON fixture in a
 * temp directory: no real session, no credentials (R11/R15).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { EnvError } from '../../src/executor/env';
import { ExecutorError } from '../../src/executor/errors';
import {
  DEFAULT_PROFILE_DIR,
  HEADLESS_VARIABLE,
  STORAGE_STATE_VARIABLE,
  resolveSessionConfig,
  type SessionConfig,
} from '../../src/executor/session';

const SWITCHES = [HEADLESS_VARIABLE, STORAGE_STATE_VARIABLE, 'MDL_PROFILE'] as const;

type Switch = (typeof SWITCHES)[number];

/** Applies a whole env state for one test and returns the restore function. */
function withEnv(values: Partial<Record<Switch, string>>): () => void {
  const previous = new Map<Switch, string | undefined>();
  for (const name of SWITCHES) previous.set(name, process.env[name]);

  for (const name of SWITCHES) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  return () => {
    for (const name of SWITCHES) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

/** Runs `action` inside an env state and always restores the switches. */
function underEnv<T>(values: Partial<Record<Switch, string>>, action: () => T): T {
  const restore = withEnv(values);
  try {
    return action();
  } finally {
    restore();
  }
}

/** Requires `action` to refuse with an `ExecutorError` (EnvError or SessionError). */
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

/** An invented storageState fixture. Contains no cookies and no credentials. */
async function storageStateFixture(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mdl-session-'));
  const file = path.join(dir, 'storage-state.json');
  await writeFile(file, `${JSON.stringify({ cookies: [], origins: [] }, null, 2)}\n`, { encoding: 'utf8' });
  return { dir, file };
}

// ----------------------------------------------------------------- the default

test('with no switches set, the local persistent profile is used and the browser is headed', () => {
  const config = underEnv({}, () => resolveSessionConfig());

  assert.deepEqual(config, {
    mode: 'persistent-profile',
    headless: false,
    profileDir: DEFAULT_PROFILE_DIR,
    storageStatePath: null,
  });
});

test('MDL_PROFILE still moves the persistent profile, so local usage is unchanged', () => {
  const config = underEnv({ MDL_PROFILE: 'D:\\sesiones\\mdl' }, () => resolveSessionConfig());

  assert.equal(config.mode, 'persistent-profile');
  assert.equal(config.profileDir, 'D:\\sesiones\\mdl');
  assert.equal(config.storageStatePath, null);
});

test('an empty or whitespace-only storage state is treated as absent, not as a path', () => {
  for (const value of ['', '   ', '\t']) {
    const config = underEnv({ [STORAGE_STATE_VARIABLE]: value }, () => resolveSessionConfig());
    assert.equal(config.mode, 'persistent-profile', `value ${JSON.stringify(value)} must mean "not set"`);
    assert.equal(config.storageStatePath, null);
    assert.equal(config.profileDir, DEFAULT_PROFILE_DIR);
  }
});

// ----------------------------------------------------------------- MDL_HEADLESS

test('MDL_HEADLESS=true launches headless in both modes', async () => {
  const local = underEnv({ [HEADLESS_VARIABLE]: 'true' }, () => resolveSessionConfig());
  assert.equal(local.headless, true);
  assert.equal(local.mode, 'persistent-profile');

  const fixture = await storageStateFixture();
  const server = underEnv(
    { [HEADLESS_VARIABLE]: 'true', [STORAGE_STATE_VARIABLE]: fixture.file },
    () => resolveSessionConfig(),
  );
  assert.equal(server.headless, true);
  assert.equal(server.mode, 'storage-state');
});

test('MDL_HEADLESS=false is headed, and the value is read case-insensitively', () => {
  const expected: [string, boolean][] = [
    ['true', true],
    ['TRUE', true],
    ['True', true],
    ['false', false],
    ['FALSE', false],
    ['  true  ', true],
  ];

  for (const [value, headless] of expected) {
    const config = underEnv({ [HEADLESS_VARIABLE]: value }, () => resolveSessionConfig());
    assert.equal(config.headless, headless, `MDL_HEADLESS=${JSON.stringify(value)}`);
  }
});

test('an invalid MDL_HEADLESS is refused, naming the variable and the accepted values', () => {
  for (const value of ['1', '0', 'yes', 'no', 'on', 'off', 'headless', 'si']) {
    const error = underEnv({ [HEADLESS_VARIABLE]: value }, () => refusal(() => resolveSessionConfig()));

    assert.ok(error instanceof EnvError, `MDL_HEADLESS=${JSON.stringify(value)} must be an EnvError`);
    const text = refusalText(error);
    assert.ok(text.includes(HEADLESS_VARIABLE), `the refusal must name ${HEADLESS_VARIABLE}`);
    assert.match(text, /true, false/, 'the refusal must list the accepted values');
    assert.ok(text.includes(JSON.stringify(value)), 'the refusal must echo what was received');
  }
});

test('an invalid MDL_HEADLESS is refused even when a storage state is configured', async () => {
  const fixture = await storageStateFixture();
  const error = underEnv(
    { [HEADLESS_VARIABLE]: 'sí', [STORAGE_STATE_VARIABLE]: fixture.file },
    () => refusal(() => resolveSessionConfig()),
  );
  assert.ok(error instanceof EnvError);
  assert.ok(refusalText(error).includes(HEADLESS_VARIABLE));
});

// ------------------------------------------------------------ MDL_STORAGE_STATE

test('a storage state switches to a non-persistent context and drops the profile', async () => {
  const fixture = await storageStateFixture();
  const config = underEnv({ [STORAGE_STATE_VARIABLE]: fixture.file }, () => resolveSessionConfig());

  assert.equal(config.mode, 'storage-state');
  assert.equal(config.storageStatePath, fixture.file);
  assert.equal(config.profileDir, null, 'the profile must not be used when a storage state is supplied');
  assert.equal(config.headless, false, 'the headless default is unchanged by the storage state');
});

test('the storage state wins over a configured profile, and headless still applies', async () => {
  const fixture = await storageStateFixture();
  const config = underEnv(
    {
      MDL_PROFILE: 'D:\\sesiones\\mdl',
      [STORAGE_STATE_VARIABLE]: fixture.file,
      [HEADLESS_VARIABLE]: 'true',
    },
    () => resolveSessionConfig(),
  );

  assert.equal(config.mode, 'storage-state');
  assert.equal(config.profileDir, null);
  assert.equal(config.storageStatePath, fixture.file);
  assert.equal(config.headless, true);
});

test('a missing storage state file is refused before any browser is launched', async () => {
  const fixture = await storageStateFixture();
  const missing = path.join(fixture.dir, 'not-exported.json');

  const error = underEnv({ [STORAGE_STATE_VARIABLE]: missing }, () => refusal(() => resolveSessionConfig()));

  assert.equal(error.name, 'SessionError');
  const text = refusalText(error);
  assert.ok(text.includes(STORAGE_STATE_VARIABLE), `the refusal must name ${STORAGE_STATE_VARIABLE}`);
  assert.ok(text.includes(missing), 'the refusal must name the unusable path');
  assert.match(text, /session-export\.mjs/, 'the operator is told how the file is produced');
});

test('a directory instead of a storage state file is refused', async () => {
  const fixture = await storageStateFixture();
  const error = underEnv({ [STORAGE_STATE_VARIABLE]: fixture.dir }, () => refusal(() => resolveSessionConfig()));

  assert.equal(error.name, 'SessionError');
  assert.match(refusalText(error), /not a file/);
});

// ----------------------------------------------------- the env-layer boundary

/** Comments may name `process.env`; the check is about executable code. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('the switches are resolved through the env layer, not scattered process.env reads', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = codeOnly(await readFile(path.resolve('src/executor/session.ts'), { encoding: 'utf8' }));

  assert.doesNotMatch(source, /process\.env/, 'session.ts must not read process.env directly');
  assert.match(source, /readEnvBool\(HEADLESS_VARIABLE/, 'MDL_HEADLESS goes through readEnvBool');
  assert.match(source, /readEnv\(STORAGE_STATE_VARIABLE/, 'MDL_STORAGE_STATE goes through readEnv');
  assert.doesNotMatch(source, /===\s*'1'/, 'the old truthy "1" headless read must be gone');
});

test('resolving the switches launches nothing and returns plain data', () => {
  // The contract the two session scripts rely on: no browser, no navigation.
  const config: SessionConfig = underEnv({}, () => resolveSessionConfig());
  for (const key of Object.keys(config)) {
    const value = (config as unknown as Record<string, unknown>)[key];
    assert.ok(
      value === null || typeof value === 'string' || typeof value === 'boolean',
      `${key} must be plain data, got ${typeof value}`,
    );
  }
});

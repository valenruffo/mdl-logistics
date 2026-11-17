/**
 * The maintenance console: tolerant reads, the file-name listing, the health
 * derivation, the explicit session check, and the absence of any purchase.
 *
 * Everything here is offline and fictional (R11): temporary directories, invented
 * run records, invented reports. No browser is opened — the session check is
 * exercised through the injected runner, which is exactly the seam the page uses.
 *
 * What is asserted:
 *  - the empty state renders notices and no invented numbers;
 *  - a corrupt record, a corrupt report or a corrupt history file is a visible
 *    warning, never a crash and never a silent zero;
 *  - the console lists artifact names and sizes only: no href, no URL, and no
 *    route answers with a file's bytes (the old `GET /artifacts/...` was removed
 *    because it served recipient PII and panel-session material);
 *  - the artifact tree being empty, missing or not a readable directory is a
 *    warning on a working page;
 *  - the health line is derived for every combination of its three facts;
 *  - the session check only runs when asked, records its exit code, and keeps a
 *    capped history; only its four closed facts (result, exit code, timestamp,
 *    duration) cross the HTTP boundary, and an unparseable history is reported by
 *    path;
 *  - no route, page or client script mentions a purchase.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ARTIFACTS_DIR,
  deriveHealth,
  readConsole,
  resolveConsoleDeps,
  type ConsoleDeps,
  type ProcessInfo,
} from '../../src/ui/console';
import { relativeSegments } from '../../src/ui/paths';
import {
  SESSION_CHECK_HISTORY_LIMIT,
  type SessionCheckEntry,
  type SessionCheckFact,
} from '../../src/ui/sessionCheck';
import type { SessionCheckRunner } from '../../src/ui/sessionCheck';

// ------------------------------------------------------------------ fixtures

const ENV_KEYS = ['MDL_STORE_ORIGIN', 'MDL_STORAGE_STATE', 'MDL_HEADLESS', 'MDL_PROFILE'] as const;

/** Sets and restores the four switches the console reads. */
async function withEnv<T>(values: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);

  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const CLEAN_ENV: Record<string, undefined> = {
  MDL_STORE_ORIGIN: undefined,
  MDL_STORAGE_STATE: undefined,
  MDL_HEADLESS: undefined,
  MDL_PROFILE: undefined,
};

interface Sandbox {
  root: string;
  recordDir: string;
  artifactsDir: string;
  historyPath: string;
  processInfo: ProcessInfo;
}

async function sandbox(name: string): Promise<Sandbox> {
  const root = await mkdtemp(path.join(tmpdir(), `mdl-console-${name}-`));
  return {
    root,
    recordDir: path.join(root, 'run-records'),
    artifactsDir: path.join(root, 'artifacts'),
    historyPath: path.join(root, 'ui', 'session-checks.json'),
    processInfo: { pid: 4242, nodeVersion: 'v22.0.0', uptimeSeconds: 90, platform: 'linux', cwd: root },
  };
}

function cleanup(box: Sandbox): void {
  rmSync(box.root, { recursive: true, force: true });
}

function depsOf(box: Sandbox, runner: SessionCheckRunner): ConsoleDeps {
  return resolveConsoleDeps({
    recordDir: box.recordDir,
    artifactsDir: box.artifactsDir,
    sessionCheckHistoryPath: box.historyPath,
    sessionCheckRunner: runner,
    processInfo: box.processInfo,
  });
}

/** A runner that must not be called: the console reads, it does not check. */
function forbiddenRunner(): SessionCheckRunner {
  return async () => {
    throw new Error('the session check must never run without an explicit request');
  };
}

function runnerReturning(stdout: string, exitCode: number | null, spawnProblem: string | null = null): SessionCheckRunner {
  return async () => ({ exitCode, stdout, stderr: '', spawnProblem, durationMs: 12 });
}

const MESSAGE_HASH = 'a'.repeat(64);
const APPROVAL_HASH = 'b'.repeat(64);

function attemptRecord(runId: string, recordedAt: string): Record<string, unknown> {
  return {
    runId,
    recordedAt,
    messageFile: '(pasted in the UI)',
    messageHash: MESSAGE_HASH,
    approvalHash: APPROVAL_HASH,
    payload: {},
    confirmation: { expected: '1901 crear', typed: '1901 crear' },
    status: 'attempted-unresolved',
    note: 'written before the click',
  };
}

function outcomeRecord(runId: string, status: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId,
    finishedAt: '2026-02-01T10:05:00.000Z',
    status,
    shipmentId: status === 'created' ? '#EM1051' : null,
    costShown: {
      summaryModality: status === 'created' ? 'Andreani a domicilio · $1234' : null,
      detailShipmentData: null,
    },
    buyButtonVisible: false,
    buyCardText: null,
    reconciliation: null,
    reportPath: 'artifacts/executor-fixture/create-run.json',
    recordedBy: 'human',
    ...patch,
  };
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' });
}

// -------------------------------------------------------------- 1. empty state

test('the empty state renders notices instead of invented numbers', async () => {
  const box = await sandbox('empty');
  try {
    await withEnv(CLEAN_ENV, async () => {
      const snapshot = await readConsole(depsOf(box, forbiddenRunner()));

      assert.equal(snapshot.status, 'ok');
      assert.deepEqual(snapshot.runs.rows, []);
      assert.equal(snapshot.runs.total, 0);
      assert.deepEqual(snapshot.artifacts.runs, []);
      assert.equal(snapshot.errors.latest, null);
      assert.equal(snapshot.session.lastCheck, null);
      assert.deepEqual(snapshot.session.checks, []);
      assert.equal(snapshot.session.history.unparseable, false, 'a missing history is not an unparseable one');
      assert.equal(snapshot.session.history.path, box.historyPath);

      // A missing directory is announced, not silently reported as zero.
      const messages = snapshot.warnings.map((warning) => `${warning.source} ${warning.message}`).join('\n');
      assert.match(messages, /todavía no existe/);
      assert.match(messages, /run-records/);

      // No recorded check means the health line cannot claim the agent can work.
      assert.equal(snapshot.health.level, 'warn');
      assert.equal(snapshot.health.canWork, false);
      assert.match(snapshot.health.line, /No se puede afirmar/);
      assert.match(snapshot.health.line, /sesión/);
    });
  } finally {
    cleanup(box);
  }
});

// ---------------------------------------------------------- 2. corrupt records

test('a corrupt record is a warning and the readable records are still listed', async () => {
  const box = await sandbox('corrupt');
  try {
    await withEnv(CLEAN_ENV, async () => {
      const runId = '2026-02-01T10-00-00-000Z-aaaaaaaaaaaa';
      await writeJson(path.join(box.recordDir, `${runId}.json`), attemptRecord(runId, '2026-02-01T10:00:00.000Z'));
      await writeJson(path.join(box.recordDir, `${runId}.outcome.json`), outcomeRecord(runId, 'created'));

      await writeFile(path.join(box.recordDir, 'broken.json'), 'not json at all\n', { encoding: 'utf8' });
      await writeJson(path.join(box.recordDir, 'junk.json'), { hello: 'world' });

      const snapshot = await readConsole(depsOf(box, forbiddenRunner()));

      assert.equal(snapshot.runs.rows.length, 2, 'the two readable records are listed');
      const good = snapshot.runs.rows.find((row) => row.runId === runId);
      assert.ok(good);
      assert.equal(good.outcome, 'created');
      assert.equal(good.shipmentId, '#EM1051');
      assert.equal(good.unresolved, false);
      assert.equal(good.resolution, null);
      assert.equal(good.messageHashShort, MESSAGE_HASH.slice(0, 12));
      assert.equal(good.approvalHashShort, APPROVAL_HASH.slice(0, 12));

      const junk = snapshot.runs.rows.find((row) => row.runId === 'junk');
      assert.ok(junk, 'a readable but unusable record is shown with its problems');
      assert.ok(junk.problems.length > 0);

      const messages = snapshot.warnings.map((warning) => `${warning.source} ${warning.message}`).join('\n');
      assert.match(messages, /broken\.json/, 'the corrupt file is named');
      assert.match(messages, /no se pudo leer el registro/);
    });
  } finally {
    cleanup(box);
  }
});

test('an unresolved record carries the gate\'s own human-resolution instruction', async () => {
  const box = await sandbox('unresolved');
  try {
    await withEnv(CLEAN_ENV, async () => {
      const runId = '2026-02-02T09-00-00-000Z-bbbbbbbbbbbb';
      await writeJson(path.join(box.recordDir, `${runId}.json`), attemptRecord(runId, '2026-02-02T09:00:00.000Z'));

      const snapshot = await readConsole(depsOf(box, forbiddenRunner()));
      const [row] = snapshot.runs.rows;
      assert.ok(row);
      assert.equal(row.unresolved, true);
      assert.equal(row.outcome, null);
      assert.match(row.resolution ?? '', /human resolution/);
      assert.match(row.resolution ?? '', new RegExp(`${runId}\\.outcome\\.json`));

      // An open record is what blocks the create path, so health says no.
      assert.equal(snapshot.health.canWork, false);
      assert.equal(snapshot.health.level, 'bad');
      assert.match(snapshot.health.line, /intentos abiertos/);
    });
  } finally {
    cleanup(box);
  }
});

test('an unreadable outcome is shown as unresolved instead of guessed away', async () => {
  const box = await sandbox('bad-outcome');
  try {
    await withEnv(CLEAN_ENV, async () => {
      const runId = '2026-02-03T09-00-00-000Z-cccccccccccc';
      await writeJson(path.join(box.recordDir, `${runId}.json`), attemptRecord(runId, '2026-02-03T09:00:00.000Z'));
      await writeFile(path.join(box.recordDir, `${runId}.outcome.json`), '{ broken', { encoding: 'utf8' });

      const snapshot = await readConsole(depsOf(box, forbiddenRunner()));
      const [row] = snapshot.runs.rows;
      assert.ok(row);
      assert.equal(row.outcome, null);
      assert.equal(row.unresolved, true);
      assert.match(row.problems.join('\n'), /no se pudo leer y se trata como no resuelto/);
    });
  } finally {
    cleanup(box);
  }
});

// ------------------------------------------------ 3. no artifact-serving route

/** A plausible artifact path: every one of these must be a 404, forever. */
const ARTIFACT_SHAPED_PATHS: readonly string[] = [
  '/artifacts/',
  '/artifacts/trace.zip',
  '/artifacts/executor-fixture/trace.zip',
  '/artifacts/executor-fixture/',
  '/artifacts/executor-fixture/create-run.json',
  '/artifacts/../secret.txt',
  '/artifacts/%2e%2e/secret.txt',
  '/artifacts/..%2fsecret.txt',
  '/artifacts/%2e%2e%2fsecret.txt',
  '/artifacts/a/../../secret.txt',
  '/artifacts/executor-fixture/../secret.txt',
  '/artifacts/C:/Windows/win.ini',
  '/artifacts//etc/passwd',
  '/artifacts/%00trace.zip',
];

test('a path a run record names is refused unless it is plain and relative', () => {
  // The download route is gone, but records still name artifact directories, so
  // the segment validation that keeps those reads inside the artifacts root stays.
  assert.deepEqual(relativeSegments('executor-fixture'), ['executor-fixture']);
  assert.deepEqual(relativeSegments('executor-fixture/create-run.json'), ['executor-fixture', 'create-run.json']);

  for (const refused of ['../secret.txt', 'a/../../secret.txt', '/etc/passwd', 'C:/Windows/win.ini', '', '.']) {
    assert.equal(relativeSegments(refused), null, `${JSON.stringify(refused)} must not be a usable relative path`);
  }
});

test('no route answers with an artifact file, and no href points at one', async () => {
  const box = await sandbox('no-artifact-route');
  const { startUiServer, handleRequest, createRoutes, PAGE_HTML, CLIENT_JS, ARTIFACT_RETRIEVAL_INSTRUCTION } =
    await import('../../src/ui/server');

  try {
    const dir = path.join(box.artifactsDir, 'executor-fixture');
    await mkdir(dir, { recursive: true });
    const marker = 'PANEL-SESSION-MATERIAL-MUST-NEVER-BE-SERVED';
    await writeFile(path.join(dir, 'trace.zip'), `${marker}\n`, { encoding: 'utf8' });
    await writeFile(path.join(dir, 'create-run.json'), `{"note":"${marker}"}\n`, { encoding: 'utf8' });
    await writeFile(path.join(box.root, 'secret.txt'), `${marker}\n`, { encoding: 'utf8' });

    const deps = {
      executor: {
        runDryRun: async () => {
          throw new Error('the console never runs the panel');
        },
        runCreate: async () => {
          throw new Error('the console never runs the panel');
        },
      },
      recordDir: box.recordDir,
      console: {
        artifactsDir: box.artifactsDir,
        sessionCheckHistoryPath: box.historyPath,
        sessionCheckRunner: forbiddenRunner(),
        processInfo: box.processInfo,
      },
    };

    const started = await startUiServer({ port: 0, deps });
    try {
      for (const artifactPath of ARTIFACT_SHAPED_PATHS) {
        for (const method of ['GET', 'POST']) {
          const response = await fetch(`${started.url}${artifactPath}`, method === 'GET' ? {} : { method });
          assert.equal(response.status, 404, `${method} ${artifactPath} answered ${response.status}`);
          const body = await response.text();
          assert.doesNotMatch(body, new RegExp(marker), `${method} ${artifactPath} must not serve the file`);
          assert.match(body, /not-found/);
        }
      }

      const page = await fetch(`${started.url}/`);
      const script = await fetch(`${started.url}/app.js`);
      assert.equal(page.status, 200);
      assert.equal(script.status, 200);

      for (const [name, source] of [
        ['the page', PAGE_HTML],
        ['the client script', CLIENT_JS],
      ] as const) {
        assert.doesNotMatch(source, /\/artifacts\//, `${name} must not name an artifact URL`);
      }
      assert.doesNotMatch(PAGE_HTML, /href\s*=/, 'the page carries no link at all');
      assert.doesNotMatch(CLIENT_JS, /\.href\s*=/, 'the script builds no link at all');
      assert.ok(
        PAGE_HTML.includes(ARTIFACT_RETRIEVAL_INSTRUCTION),
        'the page tells the operator how the files are retrieved',
      );
      assert.match(ARTIFACT_RETRIEVAL_INSTRUCTION, /SSH/);
      assert.match(ARTIFACT_RETRIEVAL_INSTRUCTION, /docker compose cp/);

      // The route table itself: every route is an exact path, and none names an artifact.
      for (const route of createRoutes(deps)) {
        assert.doesNotMatch(route.path, /artifact/i, `route ${route.path} must not serve artifacts`);
        assert.equal('prefix' in route, false, `route ${route.path} must not be a prefix`);
      }
      assert.equal((await handleRequest('GET', '/artifacts/executor-fixture/trace.zip', '', deps)).status, 404);
      assert.equal((await handleRequest('GET', '/artifacts/', '', deps)).status, 404);
    } finally {
      await started.close();
    }
  } finally {
    cleanup(box);
  }
});

test('artifacts are listed per run with their sizes and no link', async () => {
  const box = await sandbox('artifact-list');
  try {
    await withEnv(CLEAN_ENV, async () => {
      const runId = '2026-02-04T09-00-00-000Z-dddddddddddd';
      await writeJson(path.join(box.recordDir, `${runId}.json`), attemptRecord(runId, '2026-02-04T09:00:00.000Z'));
      await writeJson(path.join(box.recordDir, `${runId}.outcome.json`), outcomeRecord(runId, 'created'));

      const dir = path.join(box.artifactsDir, 'executor-fixture');
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'create-run.json'), '{"ok":true}\n', { encoding: 'utf8' });
      await writeFile(path.join(dir, 'trace.zip'), 'PK\u0003\u0004fictional', { encoding: 'utf8' });

      const snapshot = await readConsole(depsOf(box, forbiddenRunner()));
      assert.equal(snapshot.artifacts.runs.length, 1);
      const [entry] = snapshot.artifacts.runs;
      assert.ok(entry);
      assert.equal(entry.runId, runId);
      assert.equal(entry.dir, 'executor-fixture');
      assert.deepEqual(entry.files.map((file) => file.name), ['create-run.json', 'trace.zip']);
      const sizes = entry.files.map((file) => file.sizeBytes);
      assert.ok(sizes.every((size) => size > 0));
      assert.equal(entry.totalBytes, sizes.reduce((total, size) => total + size, 0));
      assert.equal('href' in entry, false, 'the listing carries no URL');
      for (const file of entry.files) assert.equal('href' in file, false, `${file.name} carries no URL`);

      // The run row names the directory; nothing on it is clickable.
      assert.equal(snapshot.runs.rows[0]?.artifactDir, 'executor-fixture');
      assert.equal('artifactHref' in (snapshot.runs.rows[0] ?? {}), false);

      // The whole snapshot is free of any URL that could return a file.
      assert.doesNotMatch(JSON.stringify(snapshot), /\/artifacts\//);
      assert.doesNotMatch(JSON.stringify(snapshot), /"href"/);
    });
  } finally {
    cleanup(box);
  }
});

test('a missing artifact directory is a visible problem, not an empty list', async () => {
  const box = await sandbox('artifact-missing');
  try {
    await withEnv(CLEAN_ENV, async () => {
      const runId = '2026-02-05T09-00-00-000Z-eeeeeeeeeeee';
      await writeJson(path.join(box.recordDir, `${runId}.json`), attemptRecord(runId, '2026-02-05T09:00:00.000Z'));
      await writeJson(path.join(box.recordDir, `${runId}.outcome.json`), outcomeRecord(runId, 'not-created'));

      const snapshot = await readConsole(depsOf(box, forbiddenRunner()));
      const [entry] = snapshot.artifacts.runs;
      assert.ok(entry);
      assert.deepEqual(entry.files, []);
      assert.match(entry.problems.join('\n'), /no existe/);
      assert.ok(snapshot.artifacts.warnings.length > 0);
    });
  } finally {
    cleanup(box);
  }
});

test('the page renders when the artifact tree is missing, empty, or not a directory', async () => {
  const box = await sandbox('artifact-shapes');
  try {
    await withEnv(CLEAN_ENV, async () => {
      const runId = '2026-02-08T09-00-00-000Z-ffffffffffff';
      await writeJson(path.join(box.recordDir, `${runId}.json`), attemptRecord(runId, '2026-02-08T09:00:00.000Z'));
      await writeJson(path.join(box.recordDir, `${runId}.outcome.json`), outcomeRecord(runId, 'created'));

      // 1. missing: the run names a directory that is not there.
      const missing = await readConsole(depsOf(box, forbiddenRunner()));
      assert.equal(missing.status, 'ok');
      assert.deepEqual(missing.artifacts.runs[0]?.files, []);
      assert.ok(missing.warnings.length > 0);

      // 2. empty: present, readable, no files.
      await mkdir(path.join(box.artifactsDir, 'executor-fixture'), { recursive: true });
      const empty = await readConsole(depsOf(box, forbiddenRunner()));
      assert.equal(empty.status, 'ok');
      assert.deepEqual(empty.artifacts.runs[0]?.files, []);

      // 3. unreadable as a directory: a regular file sits where the tree should be.
      rmSync(box.artifactsDir, { recursive: true, force: true });
      await writeFile(box.artifactsDir, 'not a directory\n', { encoding: 'utf8' });
      const unreadable = await readConsole(depsOf(box, forbiddenRunner()));
      assert.equal(unreadable.status, 'ok', 'an unreadable tree never crashes the page');
      assert.deepEqual(unreadable.artifacts.runs[0]?.files, []);
      assert.ok(unreadable.warnings.some((warning) => warning.source === box.artifactsDir));
      assert.equal(unreadable.health.level, 'bad', 'an unwritable artifacts path is not a healthy state');
    });
  } finally {
    cleanup(box);
  }
});

// ------------------------------------------------------------- 4. health facts

test('health is derived for every combination of its three facts', () => {
  const results = ['usable', 'unusable', 'config-refused', 'browser-failed'] as const;

  const entry = (result: (typeof results)[number]): SessionCheckFact => ({
    runAt: '2026-02-06T09:00:00.000Z',
    result,
    exitCode: result === 'usable' ? 0 : result === 'unusable' ? 1 : result === 'config-refused' ? 2 : 3,
    durationMs: 10,
  });

  const sessions: (SessionCheckFact | null)[] = [null, ...results.map(entry)];
  const attemptSets: string[][] = [[], ['open-run']];
  const writableFlags: boolean[] = [true, false];

  for (const session of sessions) {
    for (const unresolved of attemptSets) {
      for (const writable of writableFlags) {
        const health = deriveHealth({
          lastCheck: session,
          unresolvedRunIds: unresolved,
          artifactsWritable: writable,
          artifactsProblem: writable ? null : 'not writable',
          artifactsDir: '/tmp/artifacts',
        });

        const sessionBad = session !== null && session.result !== 'usable';
        const attemptsBad = unresolved.length > 0;
        const artifactsBad = !writable;
        const label = `${session?.result ?? 'none'}/${unresolved.length}/${String(writable)}`;

        const expectedCanWork = session !== null && session.result === 'usable' && !attemptsBad && !artifactsBad;
        const expectedLevel = sessionBad || attemptsBad || artifactsBad ? 'bad' : session === null ? 'warn' : 'ok';

        assert.equal(health.canWork, expectedCanWork, `canWork for ${label}`);
        assert.equal(health.level, expectedLevel, `level for ${label}`);
        assert.equal(health.facts.length, 3);

        if (expectedLevel === 'ok') assert.match(health.line, /^Sí:/);
        else assert.doesNotMatch(health.line, /^Sí:/, `the line for ${label} must not claim yes`);
        if (expectedLevel === 'bad') assert.match(health.line, /^No:/);
        if (expectedLevel === 'warn') assert.match(health.line, /^No se puede afirmar/);

        if (session === null) {
          assert.equal(health.facts[0]?.level, 'warn', 'a session nobody checked is a warn, never a yes');
        }
        assert.equal(health.facts[1]?.level, attemptsBad ? 'bad' : 'ok');
        assert.equal(health.facts[2]?.level, artifactsBad ? 'bad' : 'ok');
      }
    }
  }

  // The line names the fact that makes it a no.
  const blocked = deriveHealth({
    lastCheck: entry('usable'),
    unresolvedRunIds: ['run-1', 'run-2'],
    artifactsWritable: true,
    artifactsProblem: null,
    artifactsDir: '/tmp/artifacts',
  });
  assert.equal(blocked.level, 'bad');
  assert.match(blocked.line, /intentos abiertos/);
  assert.match(blocked.line, /run-1, run-2/);

  const unreadable = deriveHealth({
    lastCheck: entry('usable'),
    unresolvedRunIds: [],
    artifactsWritable: false,
    artifactsProblem: 'no se puede escribir en /tmp/artifacts',
    artifactsDir: '/tmp/artifacts',
  });
  assert.equal(unreadable.level, 'bad');
  assert.match(unreadable.line, /no se puede escribir/);
});

// --------------------------------------------------------- 5. the session check

test('the session check records the exit code, and the snapshot carries only closed facts', async () => {
  const box = await sandbox('check');
  try {
    await withEnv(CLEAN_ENV, async () => {
      const printed = '  estado: listo\nOK: la sesión es utilizable: Titular Ficticia Delvalle.\n';
      const deps = depsOf(box, runnerReturning(printed, 0));
      const { performSessionCheck } = await import('../../src/ui/console');
      const outcome = await performSessionCheck(deps);

      // The HTTP shape: four facts, and not the message the script printed.
      assert.deepEqual(Object.keys(outcome.check).sort(), ['durationMs', 'exitCode', 'result', 'runAt']);
      assert.equal(outcome.check.result, 'usable');
      assert.equal(outcome.check.exitCode, 0);
      assert.equal(outcome.check.durationMs, 12);
      assert.match(outcome.check.runAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.doesNotMatch(JSON.stringify(outcome.check), /Ficticia Delvalle/);

      assert.deepEqual(outcome.problems, []);
      assert.equal(outcome.snapshot.health.canWork, true, 'a usable check with nothing open makes the agent able to work');

      // The history file keeps the check's own text: only the projection changed.
      const stored: unknown = JSON.parse(await readFile(box.historyPath, { encoding: 'utf8' }));
      assert.ok(typeof stored === 'object' && stored !== null);
      const [recorded] = (stored as { checks: SessionCheckEntry[] }).checks;
      assert.ok(recorded);
      assert.equal(recorded.message, 'OK: la sesión es utilizable: Titular Ficticia Delvalle.');
      assert.match(recorded.output, /estado: listo/);
      assert.match(recorded.output, /Ficticia Delvalle/);
      assert.equal(recorded.opensBrowser, true);

      // The recorded check is what the console shows next time, and it is not re-run.
      const snapshot = await readConsole(depsOf(box, forbiddenRunner()));
      assert.equal(snapshot.session.lastCheck?.result, 'usable');
      assert.deepEqual(snapshot.session.checks[0], outcome.check);
      assert.deepEqual(Object.keys(snapshot.session.lastCheck ?? {}).sort(), [
        'durationMs',
        'exitCode',
        'result',
        'runAt',
      ]);
      assert.doesNotMatch(JSON.stringify(snapshot), /Ficticia Delvalle/, 'no script text reaches the snapshot');
    });
  } finally {
    cleanup(box);
  }
});

test('every documented exit code maps to its own closed result, and a spawn failure is browser-failed', async () => {
  const box = await sandbox('check-codes');
  const { performSessionCheck } = await import('../../src/ui/console');

  try {
    await withEnv(CLEAN_ENV, async () => {
      const cases: { code: number | null; problem: string | null; expected: string }[] = [
        { code: 0, problem: null, expected: 'usable' },
        { code: 1, problem: null, expected: 'unusable' },
        { code: 2, problem: null, expected: 'config-refused' },
        { code: 3, problem: null, expected: 'browser-failed' },
        { code: 9, problem: null, expected: 'browser-failed' },
        { code: null, problem: 'no se pudo iniciar el chequeo: ENOENT', expected: 'browser-failed' },
      ];

      for (const item of cases) {
        const deps = depsOf(box, runnerReturning('ERROR: la sesión no es utilizable\n', item.code, item.problem));
        const outcome = await performSessionCheck(deps);
        assert.equal(outcome.check.result, item.expected, `exit code ${String(item.code)}`);
        assert.equal(outcome.check.exitCode, item.code);
        assert.doesNotMatch(
          JSON.stringify(outcome.check),
          /ENOENT|no es utilizable/,
          'neither the spawn problem nor the printed line is part of the projection',
        );
      }

      // A runner that throws is recorded as browser-failed, never as a crash.
      const throwing = (async () => {
        throw new Error('spawn exploded');
      }) as SessionCheckRunner;
      const outcome = await performSessionCheck(depsOf(box, throwing));
      assert.equal(outcome.check.result, 'browser-failed');
      assert.deepEqual(Object.keys(outcome.check).sort(), ['durationMs', 'exitCode', 'result', 'runAt']);
      assert.doesNotMatch(JSON.stringify(outcome.check), /spawn exploded/);
    });
  } finally {
    cleanup(box);
  }
});

test('the history keeps the newest checks, capped, and survives a corrupt file', async () => {
  const box = await sandbox('check-history');
  const { performSessionCheck } = await import('../../src/ui/console');

  try {
    await withEnv(CLEAN_ENV, async () => {
      let counter = 0;
      const runner: SessionCheckRunner = async () => {
        counter += 1;
        return { exitCode: 0, stdout: `OK: corrida ${counter}`, stderr: '', spawnProblem: null, durationMs: 1 };
      };

      for (let index = 0; index < SESSION_CHECK_HISTORY_LIMIT + 2; index += 1) {
        await performSessionCheck(depsOf(box, runner));
      }

      const stored: unknown = JSON.parse(await readFile(box.historyPath, { encoding: 'utf8' }));
      const checks = (stored as { checks: SessionCheckEntry[] }).checks;
      assert.equal(checks.length, SESSION_CHECK_HISTORY_LIMIT, 'the history is capped');
      assert.equal(checks[0]?.message, `OK: corrida ${SESSION_CHECK_HISTORY_LIMIT + 2}`, 'newest first');

      // A corrupt history is a warning, and the next check still records. The
      // bytes are never quoted back, and the file is reported as unparseable by
      // path.
      const marker = 'TITULAR-FICTICIA-EN-HISTORIAL';
      await writeFile(box.historyPath, `${marker} not json`, { encoding: 'utf8' });
      const snapshot = await readConsole(depsOf(box, forbiddenRunner()));
      assert.deepEqual(snapshot.session.checks, []);
      assert.equal(snapshot.session.history.unparseable, true);
      assert.equal(snapshot.session.history.path, box.historyPath);
      assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(marker), 'never an excerpt of the file');
      assert.match(
        snapshot.warnings.map((warning) => warning.message).join('\n'),
        /no es JSON válido/,
      );

      const repaired = await performSessionCheck(depsOf(box, runnerReturning('OK: la sesión es utilizable.', 0)));
      assert.equal(repaired.snapshot.session.checks.length, 1);
      assert.equal(repaired.snapshot.session.history.unparseable, false);
      assert.match(repaired.problems.join('\n'), /no es JSON válido/);
    });
  } finally {
    cleanup(box);
  }
});

// --------------------------------------------------------------- 6. no secrets

test('no session content is rendered: only the file size and its date', async () => {
  const box = await sandbox('secrets');
  try {
    const stateFile = path.join(box.root, 'storage-state.json');
    const sessionCookie = 'COOKIE-VALUE-MUST-NEVER-APPEAR';
    await writeFile(
      stateFile,
      `${JSON.stringify({ cookies: [{ name: 'session', value: sessionCookie }], origins: [] })}\n`,
      { encoding: 'utf8' },
    );

    await withEnv(
      {
        ...CLEAN_ENV,
        MDL_STORE_ORIGIN: 'https://tienda-ficticia.mitiendanube.com',
        MDL_STORAGE_STATE: stateFile,
        MDL_HEADLESS: 'true',
      },
      async () => {
        const snapshot = await readConsole(depsOf(box, forbiddenRunner()));
        const rendered = JSON.stringify(snapshot);

        assert.doesNotMatch(rendered, new RegExp(sessionCookie), 'the session file is only stat-ed');
        assert.equal(snapshot.runtime.storeHost, 'tienda-ficticia.mitiendanube.com');
        assert.doesNotMatch(snapshot.runtime.storeHost ?? '', /^https/, 'the scheme is not part of the host');
        assert.equal(snapshot.runtime.headless, true);
        assert.equal(snapshot.session.file.mode, 'storage-state');
        assert.equal(snapshot.session.file.exists, true);
        assert.equal(snapshot.session.file.isFile, true);
        assert.ok((snapshot.session.file.sizeBytes ?? 0) > 0);
        assert.match(snapshot.session.file.modifiedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
      },
    );

    // A storageState path that points nowhere is a warning, not a crash.
    await withEnv({ ...CLEAN_ENV, MDL_STORAGE_STATE: path.join(box.root, 'missing.json') }, async () => {
      const snapshot = await readConsole(depsOf(box, forbiddenRunner()));
      assert.equal(snapshot.session.file.exists, false);
      assert.match(snapshot.session.file.problems.join('\n'), /no existe/);
      assert.ok(snapshot.warnings.length > 0);
    });
  } finally {
    cleanup(box);
  }
});

// ------------------------------------------------------------ 7. the errors tab

test('the newest failing report is reduced to closed structural facts', async () => {
  const box = await sandbox('errors');
  try {
    await withEnv(CLEAN_ENV, async () => {
      const older = path.join(box.artifactsDir, 'executor-old');
      const newer = path.join(box.artifactsDir, 'executor-new');
      const passing = path.join(box.artifactsDir, 'executor-passing');
      await mkdir(older, { recursive: true });
      await mkdir(newer, { recursive: true });
      await mkdir(passing, { recursive: true });

      await writeJson(path.join(older, 'dry-run.json'), {
        mode: 'dry-run',
        formMatchesApproval: false,
        mismatches: ['address.city: expected "Villa Ejemplo", the panel holds "Villa Ejemplx"'],
        finishedAt: '2026-02-07T09:00:00.000Z',
      });
      await writeJson(path.join(passing, 'dry-run.json'), {
        mode: 'dry-run',
        formMatchesApproval: true,
        mismatches: [],
        finishedAt: '2026-02-07T09:30:00.000Z',
      });

      // Give the second failing report a newer mtime than the first.
      const fresh = path.join(newer, 'create-run.json');
      await writeJson(fresh, {
        mode: 'create',
        formMatchesApproval: false,
        mismatches: ['carrier: expected "Andreani a domicilio", the panel holds "Entrega a domicilio"'],
        outcome: 'unknown',
        message: 'the panel does not hold the approved payload',
        finishedAt: '2026-02-07T10:00:00.000Z',
        reconciliation: { interpretation: 'one candidate row matches the recipient' },
        failedChecks: ['shipmentId', 'statusBadge', 'buyButton', 'somethingElse'],
      });
      await writeFile(path.join(box.artifactsDir, 'broken-report.json'), 'nope', { encoding: 'utf8' });

      const snapshot = await readConsole(depsOf(box, forbiddenRunner()));
      const latest = snapshot.errors.latest;
      assert.ok(latest);
      assert.equal(latest.path, 'executor-new/create-run.json');
      assert.equal(latest.kind, 'create-run');
      assert.equal(latest.unparseable, false);
      assert.equal('href' in latest, false, 'the report is named by path, never by a URL');
      assert.equal(latest.finishedAt, '2026-02-07T10:00:00.000Z');
      assert.match(latest.recordedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.deepEqual(latest.checks, [
        'shipment-id',
        'status-badge',
        'label-button',
        'form-mismatch',
        'form-not-approved',
        'outcome-unknown',
        'reconciliation-unread',
      ]);
      assert.equal(latest.unrecognisedChecks, 1, 'a name outside the vocabulary is counted, never copied');

      // The report's own free text is nowhere in the section: it can quote the
      // recipient, and this snapshot is served over HTTP.
      const rendered = JSON.stringify(snapshot.errors);
      assert.doesNotMatch(rendered, /the panel does not hold the approved payload/);
      assert.doesNotMatch(rendered, /Entrega a domicilio/);
      assert.doesNotMatch(rendered, /one candidate row matches the recipient/);
      assert.doesNotMatch(rendered, /somethingElse/);
      assert.deepEqual(Object.keys(latest).sort(), [
        'checks',
        'finishedAt',
        'kind',
        'path',
        'recordedAt',
        'unparseable',
        'unrecognisedChecks',
      ]);

      // Nothing in the report section is a URL to its contents.
      assert.doesNotMatch(rendered, /\/artifacts\//);

      // A report whose structural checks held is not an error.
      assert.ok(!snapshot.errors.latest?.path.includes('executor-passing'));
    });
  } finally {
    cleanup(box);
  }
});

test('a report that cannot be reduced to the vocabulary is unparseable, by path only', async () => {
  const box = await sandbox('errors-unparseable');
  try {
    await withEnv(CLEAN_ENV, async () => {
      const marker = 'DESTINATARIO-FICTICIO-987654';
      const dir = path.join(box.artifactsDir, 'executor-broken');
      await mkdir(dir, { recursive: true });

      // Not JSON at all, and it starts with the marker: a parse error message
      // quotes those bytes, so the warning must not be the parser's message.
      await writeFile(path.join(dir, 'failure.json'), `${marker} is not json\n`, { encoding: 'utf8' });

      const snapshot = await readConsole(depsOf(box, forbiddenRunner()));
      const latest = snapshot.errors.latest;
      assert.ok(latest, 'an unreadable failing report is still the latest one');
      assert.equal(latest.path, 'executor-broken/failure.json');
      assert.equal(latest.kind, 'failure');
      assert.equal(latest.unparseable, true);
      assert.deepEqual(latest.checks, []);
      assert.equal(latest.finishedAt, null);

      assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(marker), 'the raw bytes never reach the snapshot');
      assert.match(snapshot.warnings.map((warning) => warning.message).join('\n'), /solo la ruta/);

      // A parseable report that names no known check is unparseable too.
      const silent = path.join(box.artifactsDir, 'executor-silent');
      await mkdir(silent, { recursive: true });
      await writeJson(path.join(silent, 'failure.json'), { message: marker, note: 'nothing structural' });

      const second = await readConsole(depsOf(box, forbiddenRunner()));
      assert.equal(second.errors.latest?.unparseable, true);
      assert.doesNotMatch(JSON.stringify(second), new RegExp(marker));
    });
  } finally {
    cleanup(box);
  }
});

// ------------------------------------------------------- 8. no purchase anywhere

const PURCHASE_PATTERNS: readonly RegExp[] = [
  /comprar/i,
  /\bpurchase/i,
  /\bbuy\b/i,
  /\bpay\b/i,
  /\bpayment\b/i,
  /checkout/i,
  /\bpagar\b/i,
  /\bpago\b/i,
];

/** Comments are stripped so documentation may name the excluded action. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('no console route, handler or served byte offers a purchase', async () => {
  const box = await sandbox('purchase');
  const { createRoutes, PAGE_HTML, CLIENT_JS } = await import('../../src/ui/server');

  try {
    const routes = createRoutes({
      executor: {
        runDryRun: async () => {
          throw new Error('unused');
        },
        runCreate: async () => {
          throw new Error('unused');
        },
      },
      recordDir: box.recordDir,
      console: { artifactsDir: box.artifactsDir, sessionCheckHistoryPath: box.historyPath, sessionCheckRunner: forbiddenRunner(), processInfo: box.processInfo },
    });

    for (const route of routes) {
      const text = `${route.method} ${route.path} ${route.purpose}`;
      for (const pattern of PURCHASE_PATTERNS) {
        assert.doesNotMatch(text, pattern, `route "${text}" must not offer a purchase`);
      }
    }

    for (const [name, source] of [
      ['the page', PAGE_HTML],
      ['the client script', CLIENT_JS],
    ] as const) {
      for (const pattern of PURCHASE_PATTERNS) {
        assert.doesNotMatch(source, pattern, `${name} must not mention a purchase`);
      }
    }

    for (const entry of readdirSync(path.resolve('src/ui'))) {
      if (!entry.endsWith('.ts')) continue;
      const source = codeOnly(readFileSync(path.join('src/ui', entry), 'utf8'));
      for (const pattern of PURCHASE_PATTERNS) {
        assert.doesNotMatch(source, pattern, `src/ui/${entry} must not offer a purchase`);
      }
    }
  } finally {
    cleanup(box);
  }
});

test('the console never runs the session check on a plain read', async () => {
  const box = await sandbox('no-auto-check');

  try {
    let calls = 0;
    const counting: SessionCheckRunner = async () => {
      calls += 1;
      return { exitCode: 0, stdout: 'OK: la sesión es utilizable.', stderr: '', spawnProblem: null, durationMs: 1 };
    };

    await withEnv(CLEAN_ENV, async () => {
      for (let index = 0; index < 3; index += 1) await readConsole(depsOf(box, counting));
    });

    assert.equal(calls, 0, 'reading the console never opens a browser');
    assert.equal(ARTIFACTS_DIR, 'artifacts', 'the artifacts root is the repository default');
  } finally {
    cleanup(box);
  }
});

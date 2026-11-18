/**
 * The two review findings that closed the console's remaining job-safety holes.
 *
 * 1. **No report or check text over HTTP.** The console reads executor reports and
 *    the session-check history; a report's message, mismatch and reconciliation
 *    text and a check's own stdout can quote the recipient's name and address.
 *    This file seeds a report and a check entry with a distinctive recipient-like
 *    string and asserts it appears nowhere in `/api/console`, the page or the
 *    client script — for a well-formed report *and* for one that is not JSON at
 *    all (a parser error message quotes the bytes it choked on). A check is
 *    reduced to four closed facts and an unparseable history is reported by path.
 * 2. **One Chromium at a time.** `/api/run` and `/api/session-check` share one
 *    in-process lock; a second request is a `409` that runs nothing, the lock is
 *    released on success, refusal, failure and throw, and the session check's
 *    timeout escalates to `SIGKILL` on the process group so a wedged browser
 *    cannot outlive the check.
 *
 * Everything is offline and fictional: temporary directories, invented reports,
 * an injected executor and an injected fake child. No browser is opened, and no
 * artifact is ever served.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { analyzeMessage } from '../../src/ui/actions';
import { readConsole, resolveConsoleDeps, type ConsoleDeps } from '../../src/ui/console';
import { formValuesFromFields } from '../../src/ui/form';
import { LOCK_BUSY_MESSAGE, browserLock, withBrowserLock } from '../../src/ui/lock';
import { REPORT_ON_DISK_NOTE } from '../../src/ui/page';
import {
  runSessionCheckProcess,
  type SessionCheckChild,
  type SessionCheckRunner,
} from '../../src/ui/sessionCheck';
import type { ActionDeps, UiExecutor } from '../../src/ui/actions';
import { HAPPY_MESSAGE } from './fixtures';
import { TEST_AUTH, authFetch, testContext } from './auth-fixtures';

// ------------------------------------------------------------------ fixtures

/** A recipient-like string that must never cross the HTTP boundary. */
const RECIPIENT_MARKER = 'Maria Ficticia Delvalle 742 Calle Inventada';
const INVALID_REPORT_MARKER = 'RECIPIENTE-FICTICIO-EN-INFORME-ROTO';

interface Box {
  root: string;
  recordDir: string;
  artifactsDir: string;
  historyPath: string;
}

async function box(name: string): Promise<Box> {
  const root = await mkdtemp(path.join(tmpdir(), `mdl-hardening-${name}-`));
  return {
    root,
    recordDir: path.join(root, 'run-records'),
    artifactsDir: path.join(root, 'artifacts'),
    historyPath: path.join(root, 'ui', 'session-checks.json'),
  };
}

async function cleanup(target: Box): Promise<void> {
  await rm(target.root, { recursive: true, force: true });
}

function processInfo(root: string) {
  return { pid: 4242, nodeVersion: 'v22.0.0', uptimeSeconds: 12, platform: 'linux', cwd: root };
}

function consoleDepsOf(target: Box, runner: SessionCheckRunner): ConsoleDeps {
  return resolveConsoleDeps({
    recordDir: target.recordDir,
    artifactsDir: target.artifactsDir,
    sessionCheckHistoryPath: target.historyPath,
    sessionCheckRunner: runner,
    processInfo: processInfo(target.root),
  });
}

function forbiddenRunner(): SessionCheckRunner {
  return async () => {
    throw new Error('the session check must never run on a plain read');
  };
}

interface FakeExecutor {
  executor: UiExecutor;
  calls: string[];
}

function fakeExecutor(): FakeExecutor {
  const calls: string[] = [];
  return {
    calls,
    executor: {
      runDryRun: async () => {
        calls.push('dry-run');
        throw new Error('the network is not a test dependency');
      },
      runCreate: async () => {
        calls.push('create');
        throw new Error('the network is not a test dependency');
      },
    },
  };
}

function serverDeps(target: Box, executor: UiExecutor, runner: SessionCheckRunner): ActionDeps {
  return {
    executor,
    recordDir: target.recordDir,
    console: {
      artifactsDir: target.artifactsDir,
      sessionCheckHistoryPath: target.historyPath,
      sessionCheckRunner: runner,
      processInfo: processInfo(target.root),
    },
  };
}

/** Polls a predicate so a test never races a request it just started. */
async function waitFor(label: string, predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * A report that would be a PII disaster if it were ever returned: every free-text
 * field the executor writes carries the marker, and so does the journey readback
 * and the reconciliation.
 */
function recipientBearingReport(): Record<string, unknown> {
  return {
    mode: 'create',
    startedAt: '2026-03-01T10:00:00.000Z',
    finishedAt: '2026-03-01T10:04:00.000Z',
    approvedPayloadHash: 'a'.repeat(64),
    formPayloadHash: 'b'.repeat(64),
    formMatchesApproval: false,
    mismatches: [`address: expected ${JSON.stringify(RECIPIENT_MARKER)}, the panel holds ""`],
    message: `the shipment detail page does not prove the label is unpaid; recipient ${RECIPIENT_MARKER}`,
    journey: {
      recipient: { name: RECIPIENT_MARKER, city: 'Villa Ejemplo', address: RECIPIENT_MARKER },
      summary: { bodyText: RECIPIENT_MARKER, cards: [{ title: 'Datos del destinatario', text: RECIPIENT_MARKER }] },
    },
    reconciliation: { interpretation: `one candidate row matches ${RECIPIENT_MARKER}`, matches: [RECIPIENT_MARKER] },
    outcome: 'unknown',
    failedChecks: ['shipmentId', 'statusBadge', 'buyButton'],
  };
}

async function writeReport(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' });
}

// --------------------------------------- 1. no report text over the HTTP surface

test('a report full of recipient data contributes no text to /api/console, the page or the script', async () => {
  const target = await box('pii');
  const { startUiServer, PAGE_HTML, CLIENT_JS } = await import('../../src/ui/server');

  try {
    await writeReport(path.join(target.artifactsDir, 'executor-real', 'create-run.json'), recipientBearingReport());

    const executor = fakeExecutor();
    const started = await startUiServer({
      port: 0,
      deps: serverDeps(target, executor.executor, forbiddenRunner()),
      auth: TEST_AUTH,
    });

    try {
      const snapshotResponse = await authFetch(`${started.url}/api/console`);
      assert.equal(snapshotResponse.status, 200);
      const snapshotText = await snapshotResponse.text();

      const page = await authFetch(`${started.url}/`);
      const script = await authFetch(`${started.url}/app.js`);
      assert.equal(page.status, 200);
      assert.equal(script.status, 200);
      const pageText = await page.text();
      const scriptText = await script.text();

      for (const [name, surface] of [
        ['/api/console', snapshotText],
        ['the page', pageText],
        ['the client script', scriptText],
      ] as const) {
        assert.doesNotMatch(surface, new RegExp(RECIPIENT_MARKER), `${name} must not carry the recipient string`);
        assert.doesNotMatch(surface, new RegExp(INVALID_REPORT_MARKER), `${name} must not carry report bytes`);
        assert.doesNotMatch(surface, /Villa Ejemplo/, `${name} must not carry report content`);
        assert.doesNotMatch(surface, /one candidate row matches/, `${name} must not carry the reconciliation`);
      }

      // The JSON itself is a closed fact set: no field anywhere in the errors
      // section can hold free text copied from a report.
      const parsed = JSON.parse(snapshotText) as {
        errors: { latest: Record<string, unknown> | null };
      };
      const latest = parsed.errors.latest;
      assert.ok(latest, 'the seeded report is a failure');
      assert.deepEqual(Object.keys(latest).sort(), [
        'checks',
        'finishedAt',
        'kind',
        'path',
        'recordedAt',
        'unparseable',
        'unrecognisedChecks',
      ]);
      assert.equal(latest['kind'], 'create-run');
      assert.deepEqual(latest['checks'], ['shipment-id', 'status-badge', 'label-button', 'form-mismatch', 'form-not-approved', 'outcome-unknown', 'reconciliation-unread']);
      assert.equal(latest['unparseable'], false);

      // The page says where the full report is and that it must leave over SSH.
      assert.ok(PAGE_HTML.includes(REPORT_ON_DISK_NOTE), 'the page carries the on-disk note');
      assert.match(REPORT_ON_DISK_NOTE, /SSH/);
      assert.match(REPORT_ON_DISK_NOTE, /destinatario/);
      assert.match(pageText, /SSH/);
      assert.match(scriptText, /SSH/);
      assert.deepEqual(executor.calls, [], 'reading the console never drives the panel');

      // And the invalid report is reported by path only, over the same route,
      // without a parse-error excerpt quoting its first bytes.
      const unparseable = await (async () => {
        const second = await box('pii-broken');
        try {
          const dir = path.join(second.artifactsDir, 'executor-broken');
          await mkdir(dir, { recursive: true });
          await writeFile(
            path.join(dir, 'failure.json'),
            `${INVALID_REPORT_MARKER} is not json at all\n`,
            { encoding: 'utf8' },
          );

          const { handleRequest } = await import('../../src/ui/server');
          const answer = await handleRequest(
            'GET',
            '/api/console',
            '',
            serverDeps(second, fakeExecutor().executor, forbiddenRunner()),
            testContext(),
          );
          assert.equal(answer.status, 200);
          assert.doesNotMatch(answer.body, new RegExp(INVALID_REPORT_MARKER));
          assert.doesNotMatch(answer.body, /is not json at all/);

          const snapshot = await readConsole(consoleDepsOf(second, forbiddenRunner()));
          assert.equal(snapshot.errors.latest?.path, 'executor-broken/failure.json');
          assert.equal(snapshot.errors.latest?.unparseable, true);
          assert.equal(snapshot.errors.latest?.kind, 'failure');
          assert.deepEqual(snapshot.errors.latest?.checks, []);
          assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(INVALID_REPORT_MARKER));
          return answer.body;
        } finally {
          await cleanup(second);
        }
      })();
      assert.doesNotMatch(unparseable, new RegExp(INVALID_REPORT_MARKER));
    } finally {
      await started.close();
    }
  } finally {
    await cleanup(target);
  }
});

// -------------------------------- 1b. no check-script text over the HTTP surface

/**
 * A check prints what it saw on the panel, so its stdout can quote the recipient.
 *
 * This seeds a history entry whose `message` and `output` carry the marker, then
 * runs the check route with a runner that returns more of it, and asserts the
 * marker reaches no HTTP surface while the history file on disk keeps it
 * verbatim. `unparseable` is checked too: a history file that is not JSON is
 * reported by path, never by the bytes a parser quotes.
 */
test('a check-history entry full of recipient data contributes no text to /api/console, the page or the script', async () => {
  const target = await box('check-pii');
  const { startUiServer, PAGE_HTML } = await import('../../src/ui/server');
  const { SESSION_CHECK_OUTPUT_NOTE } = await import('../../src/ui/page');

  try {
    await mkdir(path.dirname(target.historyPath), { recursive: true });
    await writeFile(
      target.historyPath,
      `${JSON.stringify(
        {
          version: 1,
          updatedAt: '2026-03-02T10:01:00.000Z',
          checks: [
            {
              runAt: '2026-03-02T10:00:00.000Z',
              result: 'unusable',
              exitCode: 1,
              durationMs: 4_321,
              message: `ERROR: la sesión no es utilizable: ${RECIPIENT_MARKER}`,
              output: `estado: login\n${RECIPIENT_MARKER}\ntelefono 11-5555-0000`,
              opensBrowser: true,
              spawnProblem: null,
            },
          ],
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf8' },
    );

    const runner: SessionCheckRunner = async () => ({
      exitCode: 3,
      stdout: `no browser: ${RECIPIENT_MARKER}`,
      stderr: `stderr ${RECIPIENT_MARKER}`,
      spawnProblem: null,
      durationMs: 7,
    });

    const started = await startUiServer({
      port: 0,
      deps: serverDeps(target, fakeExecutor().executor, runner),
      auth: TEST_AUTH,
    });

    try {
      const snapshotResponse = await authFetch(`${started.url}/api/console`);
      assert.equal(snapshotResponse.status, 200);
      const snapshotText = await snapshotResponse.text();

      const pageText = await (await authFetch(`${started.url}/`)).text();
      const scriptText = await (await authFetch(`${started.url}/app.js`)).text();

      for (const [name, surface] of [
        ['/api/console', snapshotText],
        ['the page', pageText],
        ['the client script', scriptText],
      ] as const) {
        assert.doesNotMatch(surface, new RegExp(RECIPIENT_MARKER), `${name} must not carry the check's output`);
        assert.doesNotMatch(surface, /11-5555-0000/, `${name} must not carry the phone the check printed`);
        assert.doesNotMatch(surface, /estado: login/, `${name} must not carry the check's stdout`);
      }

      // The whole session-check shape over HTTP: four closed facts per check.
      const parsed = JSON.parse(snapshotText) as {
        session: {
          checks: Record<string, unknown>[];
          lastCheck: Record<string, unknown> | null;
          history: { path: string; unparseable: boolean };
        };
      };
      assert.equal(parsed.session.checks.length, 1);
      const [fact] = parsed.session.checks;
      assert.ok(fact);
      assert.deepEqual(Object.keys(fact).sort(), ['durationMs', 'exitCode', 'result', 'runAt']);
      assert.equal(fact['runAt'], '2026-03-02T10:00:00.000Z');
      assert.equal(fact['result'], 'unusable');
      assert.equal(fact['exitCode'], 1);
      assert.equal(fact['durationMs'], 4_321);
      assert.deepEqual(parsed.session.lastCheck, fact);
      assert.equal(parsed.session.history.unparseable, false);
      assert.equal(parsed.session.history.path, target.historyPath);

      // The page says where the full output is and that it leaves over SSH.
      assert.ok(PAGE_HTML.includes(SESSION_CHECK_OUTPUT_NOTE), 'the page carries the on-disk note');
      assert.match(SESSION_CHECK_OUTPUT_NOTE, /SSH/);
      assert.match(SESSION_CHECK_OUTPUT_NOTE, /historial/);

      // The POST route projects the check it just ran the same way...
      const post = await authFetch(`${started.url}/api/session-check`, { method: 'POST' });
      assert.equal(post.status, 200);
      const postText = await post.text();
      assert.doesNotMatch(postText, new RegExp(RECIPIENT_MARKER), 'the just-run check is projected too');
      const postBody = JSON.parse(postText) as { check: Record<string, unknown> };
      assert.deepEqual(Object.keys(postBody.check).sort(), ['durationMs', 'exitCode', 'result', 'runAt']);
      assert.equal(postBody.check['result'], 'browser-failed');

      // ...and the history file on disk still keeps everything the check printed.
      const onDisk = await readFile(target.historyPath, { encoding: 'utf8' });
      assert.match(onDisk, new RegExp(RECIPIENT_MARKER), 'the full output stays on disk');
      assert.match(onDisk, /estado: login/);
      assert.match(onDisk, /no browser:/);
    } finally {
      await started.close();
    }
  } finally {
    await cleanup(target);
  }
});

test('an unparseable check history is reported as unparseable, by path, never an excerpt', async () => {
  const target = await box('check-unparseable');
  const { handleRequest } = await import('../../src/ui/server');
  const marker = 'TITULAR-FICTICIA-EN-HISTORIAL-ROTO';

  try {
    await mkdir(path.dirname(target.historyPath), { recursive: true });
    await writeFile(target.historyPath, `${marker} {not json`, { encoding: 'utf8' });

    const answer = await handleRequest(
      'GET',
      '/api/console',
      '',
      serverDeps(target, fakeExecutor().executor, forbiddenRunner()),
      testContext(),
    );
    assert.equal(answer.status, 200);
    assert.doesNotMatch(answer.body, new RegExp(marker), 'the file bytes are never echoed');
    assert.doesNotMatch(answer.body, /Unexpected token|Unexpected end of JSON/, 'no parser message either');

    const snapshot = await readConsole(consoleDepsOf(target, forbiddenRunner()));
    assert.deepEqual(snapshot.session.checks, []);
    assert.equal(snapshot.session.lastCheck, null);
    assert.equal(snapshot.session.history.unparseable, true);
    assert.equal(snapshot.session.history.path, target.historyPath);
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(marker));
    assert.notEqual(snapshot.health.level, 'ok', 'a history nobody could read is never a yes');
  } finally {
    await cleanup(target);
  }
});

// ---------------------------------------------------- 2. one Chromium at a time

test('a second browser request while one is running is a 409 that changes nothing', async () => {
  const target = await box('lock');
  const { startUiServer } = await import('../../src/ui/server');
  const executor = fakeExecutor();

  const gate = deferred();
  let runnerCalls = 0;
  const runner: SessionCheckRunner = async () => {
    runnerCalls += 1;
    await gate.promise;
    return { exitCode: 0, stdout: 'OK: la sesión es utilizable.', stderr: '', spawnProblem: null, durationMs: 3 };
  };

  assert.equal(browserLock.free, true, 'the lock must be free before this test starts');
  const started = await startUiServer({ port: 0, deps: serverDeps(target, executor.executor, runner), auth: TEST_AUTH });

  try {
    const inFlight = authFetch(`${started.url}/api/session-check`, { method: 'POST' });
    await waitFor('the session check to start', () => runnerCalls === 1);
    assert.equal(browserLock.holder, 'session-check');

    // The same lock guards the shipment route, both modes.
    for (const mode of ['dry-run', 'create']) {
      const refused = await authFetch(`${started.url}/api/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      assert.equal(refused.status, 409, `POST /api/run (${mode}) must be refused while a check runs`);
      const body = (await refused.json()) as { status: string; reason: string; heldBy: string };
      assert.equal(body.status, 'busy');
      assert.equal(body.reason, LOCK_BUSY_MESSAGE);
      assert.match(body.reason, /un solo Chromium/, 'the message says why');
      assert.match(body.reason, /no se cambió nada/, 'the message says nothing changed');
      assert.equal(body.heldBy, 'session-check');
    }

    // A second check is refused too, and it does not start a second browser.
    const secondCheck = await authFetch(`${started.url}/api/session-check`, { method: 'POST' });
    assert.equal(secondCheck.status, 409);
    assert.equal(((await secondCheck.json()) as { reason: string }).reason, LOCK_BUSY_MESSAGE);
    assert.equal(runnerCalls, 1, 'the refused request never reached the runner');
    assert.equal(browserLock.holder, 'session-check', 'a refused request does not steal the lock');

    // Release the in-flight check: it completes normally and frees the lock.
    gate.resolve();
    const completed = await inFlight;
    assert.equal(completed.status, 200);
    const completedBody = (await completed.json()) as { check: { result: string } };
    assert.equal(completedBody.check.result, 'usable');
    assert.equal(browserLock.free, true, 'a successful check releases the lock');

    // And the next request is served, so the process is not wedged.
    const after = await authFetch(`${started.url}/api/session-check`, { method: 'POST' });
    assert.equal(after.status, 200);
  } finally {
    gate.resolve();
    await started.close();
    assert.equal(browserLock.free, true);
  }
});

test('a throwing handler releases the lock, and so does an executor that throws after its pre-click record', async () => {
  const target = await box('lock-throw');
  const { startUiServer } = await import('../../src/ui/server');

  assert.equal(browserLock.free, true);

  await assert.rejects(
    withBrowserLock('run', async () => {
      throw new Error('the run exploded');
    }),
    /the run exploded/,
  );
  assert.equal(browserLock.free, true, 'a throw inside the lock releases it');

  // The lock is still usable afterwards.
  const again = await withBrowserLock('run', async () => 'ran');
  assert.equal(again.ok, true);
  assert.equal(browserLock.free, true);

  // The real route: a creation whose executor throws right after the attempt
  // record was written still returns, still leaves the record unresolved, and
  // still frees the lock.
  const analyzed = analyzeMessage(HAPPY_MESSAGE);
  assert.equal(analyzed.status, 'parsed');
  if (analyzed.status !== 'parsed') return;
  const form = formValuesFromFields(analyzed.fields);

  const throwing: UiExecutor = {
    runDryRun: async () => {
      throw new Error('unused');
    },
    runCreate: async () => {
      throw new Error('the panel died after the pre-click record');
    },
  };

  const started = await startUiServer({ port: 0, deps: serverDeps(target, throwing, forbiddenRunner()), auth: TEST_AUTH });
  try {
    const post = (): Promise<Response> =>
      authFetch(`${started.url}/api/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'create', message: HAPPY_MESSAGE, form }),
      });

    const response = await post();
    assert.equal(response.status, 200, 'the route answers, it does not hang or 409');
    const body = (await response.json()) as { status: string; recordPath: string | null };
    assert.equal(body.status, 'failed');
    assert.ok(body.recordPath, 'the pre-click record was already written when the executor threw');
    assert.ok(existsSync(body.recordPath), 'and it is on disk, unresolved');

    assert.equal(browserLock.free, true, 'the route frees the lock whatever the run did');

    // The next attempt is refused by the prior-attempt gate, not by the lock:
    // the lock is available again even after the throw.
    const second = await post();
    assert.equal(second.status, 200, 'the lock is free again, so this is a run, not a 409');
    const secondBody = (await second.json()) as { status: string; stage?: string };
    assert.equal(secondBody.status, 'refused');
    assert.equal(secondBody.stage, 'prior-attempt');
  } finally {
    await started.close();
  }
});

// ---------------------------------------- 3. the session check timeout escalates

function fakeChild(options: { onKill?: (signal: string) => void } = {}): {
  child: SessionCheckChild;
  closeListeners: ((code: number | null) => void)[];
  errorListeners: ((error: unknown) => void)[];
} {
  const closeListeners: ((code: number | null) => void)[] = [];
  const errorListeners: ((error: unknown) => void)[] = [];
  const child: SessionCheckChild = {
    pid: 987_654,
    stdout: null,
    stderr: null,
    on(event: string, listener: (...args: never[]) => void) {
      if (event === 'close') closeListeners.push(listener as (code: number | null) => void);
      if (event === 'error') errorListeners.push(listener as (error: unknown) => void);
      return undefined;
    },
    kill(signal?: string) {
      options.onKill?.(signal ?? 'SIGTERM');
      return true;
    },
  };
  return { child, closeListeners, errorListeners };
}

test('the timeout sends SIGTERM, then SIGKILL to the whole group, and frees the lock', async () => {
  const signals: string[] = [];
  const { child } = fakeChild();

  const guarded = await withBrowserLock('session-check', () =>
    runSessionCheckProcess({
      spawnChild: () => child,
      timeoutMs: 5,
      graceMs: 5,
      signalGroup: (_target, signal) => {
        signals.push(signal);
      },
    }),
  );

  assert.equal(guarded.ok, true, 'the check ran inside the lock');
  assert.equal(signals[0], 'SIGTERM', 'the polite signal goes first');
  assert.equal(signals[1], 'SIGKILL', 'the group is killed when the grace period ends');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'], 'no third signal, no signal before the timeout');

  if (!guarded.ok) return;
  assert.equal(guarded.value.exitCode, null, 'a killed check has no exit code');
  assert.match(guarded.value.spawnProblem ?? '', /SIGKILL/);
  assert.match(guarded.value.spawnProblem ?? '', /Chromium/);
  assert.equal(browserLock.free, true, 'the escalation resolves, so the lock comes back');
});

test('a child that dies during the grace period is not killed again', async () => {
  const signals: string[] = [];
  const { child, closeListeners } = fakeChild();

  const guarded = await withBrowserLock('session-check', () =>
    runSessionCheckProcess({
      spawnChild: () => child,
      timeoutMs: 5,
      graceMs: 500,
      signalGroup: (_target, signal) => {
        signals.push(signal);
        if (signal === 'SIGTERM') setTimeout(() => closeListeners.forEach((listener) => listener(null)), 1);
      },
    }),
  );

  assert.deepEqual(signals, ['SIGTERM'], 'SIGKILL is unnecessary once the group is gone');
  if (!guarded.ok) return;
  assert.equal(guarded.value.exitCode, null);
  assert.match(guarded.value.spawnProblem ?? '', /SIGTERM/);
  assert.equal(browserLock.free, true);
});

test('the check that finishes in time reports its exit code and is never signalled', async () => {
  const signals: string[] = [];
  const { child, closeListeners } = fakeChild();

  const guarded = await withBrowserLock('session-check', async () => {
    const running = runSessionCheckProcess({
      spawnChild: () => child,
      timeoutMs: 1_000,
      graceMs: 1_000,
      signalGroup: (_target, signal) => {
        signals.push(signal);
      },
    });
    setTimeout(() => closeListeners.forEach((listener) => listener(0)), 5);
    return await running;
  });

  assert.deepEqual(signals, [], 'a check that ends on its own is not signalled');
  if (!guarded.ok) return;
  assert.equal(guarded.value.exitCode, 0);
  assert.equal(guarded.value.spawnProblem, null);
  assert.equal(browserLock.free, true);
});

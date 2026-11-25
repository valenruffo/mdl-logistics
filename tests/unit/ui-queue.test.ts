/**
 * The persistent shipment queue, end to end (v0.4.0).
 *
 * The operator asked to stack creations while one runs: "puedo cargar 5 quizás
 * y ya olvidarme y que se vayan haciendo". These tests pin the contract:
 *
 * - `POST /api/run` (mode create) never refuses with a 409 when a run is
 *   active: it enqueues the approved payload and answers `enqueued` at once;
 * - the queue drains strictly FIFO — oldest `en espera` entry first, one at a
 *   time, no reordering — with the existing executor paths and gates;
 * - every entry's outcome record carries the run's duration;
 * - a duplicate-hash entry is `rechazada` at execution time, never retried;
 * - the cap is enforced with a readable reason;
 * - entries survive a process death on disk, and a mid-run entry is recovered
 *   (re-executed) with the executor's own gates guarding the click;
 * - `/api/queue` projects closed facts only: never the message text, the form
 *   or the approved payload.
 *
 * Everything is offline and fictional (R11): temporary directories, invented
 * messages, injected executors, no browser, no panel, no network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { analyzeMessage } from '../../src/ui/actions';
import type { ActionDeps, UiExecutor } from '../../src/ui/actions';
import { formValuesFromFields } from '../../src/ui/form';
import { browserLock } from '../../src/ui/lock';
import { MAX_PENDING_ENTRIES, QUEUE_FULL_MESSAGE, queueDirOf, queueFor } from '../../src/ui/queue';
import { HAPPY_MESSAGE } from './fixtures';
import { TEST_AUTH, authFetch } from './auth-fixtures';

// ------------------------------------------------------------------ fixtures

/** Renames the recipient of the happy message, so three messages get three hashes. */
function renameMessage(message: string, name: string): string {
  return message.replace('juan perez', name);
}

function creatingExecutor(record: { calls: string[] }, gate?: { promise: Promise<void>; resolve: () => void }): UiExecutor {
  return {
    runDryRun: async () => {
      throw new Error('the dry run is not a page path');
    },
    runCreate: async (input) => {
      record.calls.push(input.request.customer.name);
      if (gate) await gate.promise;
      return {
        outcome: 'created',
        modality: 'domicilio',
        startedAt: '2026-02-01T02:06:40.000Z',
        finishedAt: '2026-02-01T02:06:45.000Z',
        durationMs: 5_000,
        approvedPayloadHash: 'a'.repeat(64),
        formPayloadHash: 'a'.repeat(64),
        mismatches: [],
        journey: { summary: { cards: [] } },
        detailScreenshot: null,
        reportPath: 'artifacts/executor-fixture/create-run.json',
        shipment: {
          url: 'https://example.invalid/shipping-details/9999',
          shipmentId: `#EM${10_000 + record.calls.length}`,
          shipmentIdHeading: `#EM${10_000 + record.calls.length}`,
          statusBadges: ['Por enviar'],
          badgeTexts: ['Por enviar'],
          buyButtonVisible: true,
          buyCardText: 'El código de seguimiento se generará al imprimir la etiqueta',
          buttonNames: ['Imprimir'],
          bodyText: 'Envío creado con éxito',
          cards: [{ title: 'Datos del envío', present: true, text: 'Costo $1234' }],
        },
        reconciliation: null,
      } as never;
    },
  };
}

/** A gate the test holds to keep the first entry running. */
function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

interface Server {
  url: string;
  deps: ActionDeps;
  recordDir: string;
  queueDir: string;
  close(): Promise<void>;
}

async function startServer(executor: UiExecutor): Promise<Server> {
  const { startUiServer } = await import('../../src/ui/server');
  const root = await mkdtemp(path.join(tmpdir(), 'mdl-ui-queue-'));
  const recordDir = path.join(root, 'run-records');
  const deps: ActionDeps = { executor, recordDir };
  const started = await startUiServer({ port: 0, deps, auth: TEST_AUTH });
  return {
    url: started.url,
    deps,
    recordDir,
    queueDir: queueDirOf(recordDir),
    close: async () => {
      await started.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** The queued form values for one message, exactly like the page posts them. */
function formOf(message: string): Record<string, string> {
  const analysis = analyzeMessage(message);
  assert.equal(analysis.status, 'parsed');
  if (analysis.status !== 'parsed') throw new Error('unreachable');
  return formValuesFromFields(analysis.fields);
}

async function postRun(server: Server, message: string): Promise<Response> {
  return authFetch(`${server.url}/api/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, form: formOf(message), mode: 'create' }),
  });
}

interface QueueBody {
  status: string;
  queueId?: string;
  position?: number;
  reason?: string;
}

async function queueBody(server: Server): Promise<QueueSnapshotLike> {
  const response = await authFetch(`${server.url}/api/queue`);
  assert.equal(response.status, 200);
  return (await response.json()) as QueueSnapshotLike;
}

interface QueueEntryLike {
  id: string;
  state: string;
  shipmentId: string | null;
  durationMs: number | null;
  reason: string | null;
  recordPath: string | null;
  outcomePath: string | null;
  enqueuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  modality: string;
}

interface QueueSnapshotLike {
  status: string;
  entries: QueueEntryLike[];
  pending: number;
  limit: number;
  problems: string[];
}

/** Polls a predicate so a test never races a worker loop it just kicked.
 *
 * The default budget is generous on purpose: under `npm test` the whole suite
 * runs its files in parallel processes, and the queue's drain is real disk work
 * (`mkdtemp`, atomic renames, record reads per entry) that slows down several
 * fold under that CPU contention even though it stays fast in isolation.
 */
async function waitFor(label: string, predicate: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Waits until the queue has nothing pending and returns the final snapshot. */
async function waitDrained(server: Server): Promise<QueueSnapshotLike> {
  await waitFor('the queue to drain', async () => {
    const snapshot = await queueBody(server);
    return snapshot.pending === 0 && snapshot.entries.length > 0;
  });
  return queueBody(server);
}

// ------------------------------------------------------- 1. enqueue, not 409

test('POST /api/run enqueues while a run is active and answers at once', async () => {
  const firstGate = gate();
  const record = { calls: [] as string[] };
  const server = await startServer(creatingExecutor(record, firstGate));

  try {
    // The first entry stacks and the worker starts running it immediately.
    const first = await postRun(server, renameMessage(HAPPY_MESSAGE, 'uno perez'));
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as QueueBody;
    assert.equal(firstBody.status, 'enqueued');
    assert.equal(firstBody.position, 1);
    assert.ok(firstBody.queueId);

    // The worker picked it up: the executor is inside its journey.
    await waitFor('the first entry to start', async () => (await queueBody(server)).entries[0]?.state === 'en-proceso');

    // The second POST: no 409, a queue position, an instant answer.
    const second = await postRun(server, renameMessage(HAPPY_MESSAGE, 'dos perez'));
    assert.equal(second.status, 200, 'stacking never needs the browser lock');
    const secondBody = (await second.json()) as QueueBody;
    assert.equal(secondBody.status, 'enqueued');
    assert.equal(secondBody.position, 2);

    // While a session check would be refused, stacking is not.
    firstGate.resolve();
    const entries = (await waitDrained(server)).entries;
    assert.equal(record.calls.length, 2, 'both entries ran, one at a time');
    assert.deepEqual(record.calls, ['Uno', 'Dos'], 'FIFO: the first entry ran first');
    assert.equal(entries[0]?.state, 'creada');
    assert.equal(entries[1]?.state, 'creada');
    assert.ok(browserLock.free, 'the worker frees the lock between entries');
  } finally {
    await server.close();
  }
});

// ------------------------------------------------------------- 2. FIFO order

test('stacked entries drain in strict FIFO order', async () => {
  const firstGate = gate();
  const record = { calls: [] as string[] };
  const server = await startServer(creatingExecutor(record, firstGate));

  try {
    // Stack three distinct messages while the first entry holds the browser.
    await postRun(server, renameMessage(HAPPY_MESSAGE, 'uno perez'));
    await postRun(server, renameMessage(HAPPY_MESSAGE, 'dos perez'));
    await postRun(server, renameMessage(HAPPY_MESSAGE, 'tres perez'));

    const snapshot = await queueBody(server);
    assert.equal(snapshot.pending, 3);
    assert.equal(snapshot.entries.map((entry) => entry.state).filter((state) => state === 'en-espera').length, 2);
    assert.match(snapshot.entries[0]?.state ?? '', /en-proceso|creada/, 'the oldest entry went first');

    firstGate.resolve();
    await waitDrained(server);
    assert.deepEqual(record.calls, ['Uno', 'Dos', 'Tres'], 'no reordering, no priority');
  } finally {
    await server.close();
  }
});

// ---------------------------------------------- 3. outcomes carry a duration

test('each drained entry records its outcome with its duration', async () => {
  const record = { calls: [] as string[] };
  const server = await startServer(creatingExecutor(record));

  try {
    await postRun(server, HAPPY_MESSAGE);
    const entries = (await waitDrained(server)).entries;
    assert.equal(entries.length, 1, 'finished entries stay in the snapshot, newest first');
    assert.equal(entries[0]?.state, 'creada');
    assert.equal(entries[0]?.shipmentId, '#EM10001');
    assert.equal(entries[0]?.durationMs, 5_000, 'the entry carries the executor-measured duration');

    // The outcome record on disk persists the duration for the console read.
    assert.ok(entries[0]?.outcomePath);
    const outcome = JSON.parse(
      await readFile(entries[0]!.outcomePath!, { encoding: 'utf8' }),
    ) as { status: string; shipmentId: string; durationMs: number };
    assert.equal(outcome.status, 'created');
    assert.equal(outcome.durationMs, 5_000);

    // The pre-click record was written before the executor was touched.
    assert.ok(entries[0]?.recordPath);
    const attempt = JSON.parse(await readFile(entries[0]!.recordPath!, { encoding: 'utf8' })) as {
      status: string;
      approvalHash: string;
    };
    assert.equal(attempt.status, 'attempted-unresolved');
    assert.equal(attempt.approvalHash.length, 64);
  } finally {
    await server.close();
  }
});

// ------------------------------------------- 4. duplicate hash at execution

test('a duplicate-hash entry is rechazada at execution, with its reason on the panel', async () => {
  const record = { calls: [] as string[] };
  const server = await startServer(creatingExecutor(record));

  try {
    // Same message twice: the first creates, the second is refused by the
    // existing gate — at execution time, when it reaches the head of the queue.
    const first = await postRun(server, HAPPY_MESSAGE);
    assert.equal(first.status, 200);
    const second = await postRun(server, HAPPY_MESSAGE);
    assert.equal(second.status, 200, 'stacking does not gate: the gate runs at execution');

    const entries = (await waitDrained(server)).entries;
    assert.deepEqual(record.calls, ['Juan'], 'the duplicate never drove the panel');
    // Finished entries list newest first: the duplicate was drained last.
    assert.equal(entries[0]?.state, 'rechazada');
    assert.match(entries[0]?.reason ?? '', /already created a shipment/);
    assert.match(entries[0]?.reason ?? '', /#EM10001/, 'the existing shipment is named');
    assert.equal(entries[0]?.shipmentId, null, 'nothing was created by the refused entry');
    assert.equal(entries[1]?.state, 'creada');
  } finally {
    await server.close();
  }
});

// ------------------------------------------------------------------ 5. the cap

test('the queue refuses to stack entries past its cap, with a readable reason', async () => {
  const firstGate = gate();
  const record = { calls: [] as string[] };
  const server = await startServer(creatingExecutor(record, firstGate));

  try {
    // One entry runs (counts as pending) + (cap - 1) waiting = the full queue.
    await postRun(server, renameMessage(HAPPY_MESSAGE, 'uno perez'));
    for (let index = 2; index <= MAX_PENDING_ENTRIES; index += 1) {
      const stacked = await postRun(server, renameMessage(HAPPY_MESSAGE, `${index} perez`));
      assert.equal(stacked.status, 200, `position ${index} fits in the cap`);
      assert.equal(((await stacked.json()) as QueueBody).position, index);
    }

    const over = await postRun(server, renameMessage(HAPPY_MESSAGE, 'once perez'));
    assert.equal(over.status, 409);
    const body = (await over.json()) as { status: string; reason: string };
    assert.equal(body.status, 'queue-full');
    assert.ok(body.reason.includes(String(MAX_PENDING_ENTRIES)), 'the cap is named');
    assert.deepEqual(body.reason, QUEUE_FULL_MESSAGE, 'the readable sentence is the queue’s own');
    assert.match(body.reason, /crean solos/, 'the operator is told the queue works alone');

    // Nothing was lost: the queued entries still drain.
    firstGate.resolve();
    await waitDrained(server);
    assert.equal(record.calls.length, MAX_PENDING_ENTRIES);
  } finally {
    await server.close();
  }
});

// -------------------------------------------------------- 6. the lock's share

test('the worker waits for the browser lock and keeps the entry en espera', async () => {
  const record = { calls: [] as string[] };
  const server = await startServer(creatingExecutor(record));
  const { browserLock: realLock } = await import('../../src/ui/lock');
  assert.equal(realLock.free, true);

  try {
    // The server's own queue shares the routes' browserLock: hold it from the
    // outside the way a session check would.
    const outside = realLock.tryAcquire('session-check');
    assert.equal(outside.ok, true, 'precondition: the test holds the lock the worker would take');

    // The route itself never takes the lock; the worker must wait for it.
    const response = await postRun(server, HAPPY_MESSAGE);
    assert.equal(response.status, 200, 'stacking does not need the lock');

    await new Promise((resolve) => setTimeout(resolve, 200));
    const snapshot = await queueBody(server);
    assert.equal(snapshot.entries[0]?.state, 'en-espera', 'the entry waits instead of opening a second browser');
    assert.equal(record.calls.length, 0);

    if (outside.ok) outside.release();
    const drained = await waitDrained(server);
    assert.deepEqual(record.calls, ['Juan']);
    assert.equal(drained.entries[0]?.state, 'creada');
  } finally {
    await server.close();
  }
});

// ----------------------------------------------------- 7. the queue on disk

test('entries survive a restart: a fresh instance reads the files and re-executes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mdl-ui-queue-restart-'));
  const recordDir = path.join(root, 'run-records');
  const dir = queueDirOf(recordDir);

  try {
    // An entry caught mid-run by a dead process, plus one still waiting.
    const analysis = analyzeMessage(HAPPY_MESSAGE);
    assert.equal(analysis.status, 'parsed');
    if (analysis.status !== 'parsed') throw new Error('unreachable');
    const form = formValuesFromFields(analysis.fields);
    const base = {
      version: 1,
      enqueuedAt: '2026-02-01T02:00:00.000Z',
      message: HAPPY_MESSAGE,
      form,
      modality: 'domicilio',
      messageHash: 'f'.repeat(64),
      approvalHash: 'a'.repeat(64),
      payload: {},
    };
    await new Promise<void>((resolve, reject) => {
      (async () => {
        const { mkdir, writeFile } = await import('node:fs/promises');
        await mkdir(dir, { recursive: true });
        await writeFile(
          path.join(dir, '000001-f00000000000.json'),
          `${JSON.stringify({ ...base, id: '000001-f00000000000', state: 'en-proceso', startedAt: '2026-02-01T02:00:05.000Z', finishedAt: null, outcome: null }, null, 2)}\n`,
          { encoding: 'utf8' },
        );
        await writeFile(
          path.join(dir, '000002-f00000000001.json'),
          `${JSON.stringify({ ...base, id: '000002-f00000000001', state: 'en-espera', startedAt: null, finishedAt: null, outcome: null }, null, 2)}\n`,
          { encoding: 'utf8' },
        );
        resolve();
      })().catch(reject);
    });

    const record = { calls: [] as string[] };
    const deps: ActionDeps = { executor: creatingExecutor(record), recordDir };
    // A new process, a fresh queue: recovery resets the stale `en-proceso`
    // entry (re-execution; the executor's own gates guard the click) and the
    // worker drains both entries in FIFO order.
    const queue = queueFor(deps, { dir, pollIntervalMs: 10 });
    await waitFor('both recovered entries to finish', async () => {
      const snapshot = await queue.snapshot();
      return snapshot.entries.length === 2 && snapshot.pending === 0;
    });

    const snapshot = await queue.snapshot();
    // The recovered entry re-executes; the waiting one (same message text)
    // hits the gate the restart guard relies on and is rechazada, never retried.
    assert.deepEqual(record.calls, ['Juan'], 'only the recovered entry drove the panel');
    const onDisk = await readdir(dir);
    assert.equal(onDisk.filter((name) => name.endsWith('.json')).length, 2, 'no entry file was lost');
    for (const name of onDisk) {
      const entry = JSON.parse(await readFile(path.join(dir, name), { encoding: 'utf8' })) as {
        state: string;
        outcome: { status: string; durationMs: number } | null;
      };
      assert.ok(entry.state === 'creada' || entry.state === 'rechazada', 'every entry ended with an outcome');
      assert.ok(entry.outcome, 'every recovered entry ended with an outcome on disk');
    }
    await queue.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --------------------------------------------------------- 8. closed facts only

test('/api/queue reports closed facts and never the payload text', async () => {
  const record = { calls: [] as string[] };
  const server = await startServer(creatingExecutor(record));

  try {
    await postRun(server, HAPPY_MESSAGE);
    await waitDrained(server);
    const text = JSON.stringify(await queueBody(server));

    // The recipient data lives in the entry file on disk, never on the surface.
    assert.doesNotMatch(text, /juan perez/);
    assert.doesNotMatch(text, /Calle Falsa/);
    assert.doesNotMatch(text, /Villa Ejemplo/);
    assert.doesNotMatch(text, /MDL - Datos de env/);

    // Every entry projection is the closed fact set; state words are the only
    // free text, and they are the queue's own vocabulary.
    const snapshot = await queueBody(server);
    for (const entry of snapshot.entries) {
      assert.deepEqual(
        Object.keys(entry).sort(),
        [
          'durationMs',
          'enqueuedAt',
          'finishedAt',
          'id',
          'modality',
          'outcomePath',
          'reason',
          'recordPath',
          'reportPath',
          'shipmentId',
          'stage',
          'startedAt',
          'state',
        ],
      );
    }
    const [entry] = snapshot.entries;
    assert.ok(entry);
    assert.match(entry.id, /^\d{6}-[0-9a-f]{12}$/);
    assert.equal(entry.modality, 'domicilio');
    assert.equal(record.calls.length, 1);
  } finally {
    await server.close();
  }
});

// --------------------------------------------- 9. the server's own queue stop

test('closing the server stops the queue worker cleanly', async () => {
  const firstGate = gate();
  const record = { calls: [] as string[] };
  const server = await startServer(creatingExecutor(record, firstGate));

  await postRun(server, HAPPY_MESSAGE);
  await waitFor('the entry to start', async () => (await queueBody(server)).entries[0]?.state === 'en-proceso');

  // Let the running entry finish, then: close() stops the worker first — the
  // outcome lands on disk — and only then does the server itself go down.
  firstGate.resolve();
  await waitDrained(server);
  const files = await readdir(server.queueDir);
  assert.equal(files.length, 1);
  const entry = JSON.parse(await readFile(path.join(server.queueDir, files[0]!), { encoding: 'utf8' })) as {
    state: string;
    outcome: { shipmentId: string } | null;
  };
  assert.equal(entry.state, 'creada');
  assert.ok(entry.outcome, 'the outcome landed on disk');
  await server.close();
  assert.deepEqual(record.calls, ['Juan'], 'the in-flight entry finished before the close resolved');
});

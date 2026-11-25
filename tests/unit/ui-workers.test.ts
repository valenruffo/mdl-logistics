/**
 * The three upgrades the operator asked for after running the flow for real
 * (`#EM1067`, `#EM1068` created back to back):
 *
 * 1. **The total run duration.** The executor measures the journey where it
 *    begins and ends (`src/executor/run.ts`), `runAttempt` dispatches with a
 *    `startedAt` clock of its own, the outcome record persists `durationMs`
 *    (both modalities, every outcome that ran), the created card prints
 *    `Duración: 19,4 s`, the workers panel prints
 *    `#EM1068 · creada · 02:07 · 19s`, and the real post-run card carries the
 *    true duration as its final line over whatever the estimate claimed.
 * 2. **`Analizar` stays enabled during a run.** The executor is single-flight
 *    (one Chromium, one session) so `Crear envío` cannot run in parallel — the
 *    page says so next to the button. But analyzing a NEW pasted message while
 *    one runs must work: the preview is pure parsing, no browser, and its
 *    fetch was never behind the browser lock. That analyzed message is the
 *    queue: it stays on screen when the response arrives and the create button
 *    is ready again immediately.
 * 3. **The workers panel on the right.** The desk is two columns: the message
 *    + fields + create column on the left, and a Corridas panel on the right
 *    listing the runs executing or recently executed. The in-flight run is the
 *    first worker card, with the live percentage from the existing progress
 *    machinery; on response it snaps to its final state with its duration.
 *    No dialogs, no new dependencies.
 *
 * Everything is offline and fictional (R11): temporary directories, invented
 * messages, an injected executor, a stubbed `fetch`, an injected clock. No
 * browser, no panel, no network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { CARRIER_NAME } from '../../src/core/carrier';
import { parseMessage } from '../../src/core/parse-message';
import { readConsole, resolveConsoleDeps } from '../../src/ui/console';
import { formValuesFromFields } from '../../src/ui/form';
import { CLIENT_JS, PAGE_HTML } from '../../src/ui/server';
import { analyzeMessage } from '../../src/ui/actions';
import { HAPPY_MESSAGE, SUCURSAL_MESSAGE } from './fixtures';
import { TEST_AUTH, sessionCookieHeader } from './auth-fixtures';

// -------------------------------------------------------------- the fixtures

/** The second message the operator pastes while the first run is in flight. */
const SECOND_MESSAGE = SUCURSAL_MESSAGE;

/**
 * A created result exactly as the executor returns it: the journey's own
 * `startedAt`/`finishedAt` and the duration measured inside `run.ts`.
 */
const CREATED_EXECUTOR_RESULT = {
  outcome: 'created',
  modality: 'domicilio',
  startedAt: '2026-02-01T02:06:40.000Z',
  finishedAt: '2026-02-01T02:07:00.000Z',
  durationMs: 19_400,
  approvedPayloadHash: 'a'.repeat(64),
  formPayloadHash: 'a'.repeat(64),
  mismatches: [],
  journey: {
    summary: { cards: [{ title: 'Modalidad de envío', text: `${CARRIER_NAME} · Costo $1234` }] },
  },
  detailScreenshot: null,
  reportPath: 'artifacts/executor-fixture/create-run.json',
  shipment: {
    url: 'https://example.invalid/shipping-details/9999',
    shipmentId: '#EM1055',
    shipmentIdHeading: '#EM1055',
    statusBadges: ['Por enviar', 'Envío manual'],
    badgeTexts: ['Por enviar', 'Envío manual'],
    buyButtonVisible: true,
    buyCardText: 'El código de seguimiento se generará al imprimir la etiqueta',
    buttonNames: ['Imprimir'],
    bodyText: 'Envío creado con éxito',
    cards: [{ title: 'Datos del envío', present: true, text: `${CARRIER_NAME} · Costo $1234` }],
  },
  reconciliation: null,
} as never;

function fakeExecutor(result: unknown, gate?: Promise<void>): never {
  const runCreate = async (): Promise<unknown> => {
    if (gate) await gate;
    return result;
  };
  return {
    runDryRun: async () => {
      throw new Error('the dry run is not a page path');
    },
    runCreate,
  } as never;
}

function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: sessionCookieHeader() },
    body: JSON.stringify(body),
  });
}

interface QueueEntryLike {
  state: string;
  shipmentId: string | null;
  durationMs: number | null;
  outcomePath: string | null;
}

/** Polls `/api/queue` until the queue has nothing pending; the budget tolerates a busy suite. */
async function waitDrainedQueue(url: string): Promise<{ entries: QueueEntryLike[] }> {
  const startedAt = Date.now();
  for (;;) {
    const response = await fetch(`${url}/api/queue`, { headers: { cookie: sessionCookieHeader() } });
    assert.equal(response.status, 200);
    const snapshot = (await response.json()) as { pending: number; entries: QueueEntryLike[] };
    if (snapshot.pending === 0 && snapshot.entries.length > 0) return snapshot;
    if (Date.now() - startedAt > 30_000) throw new Error('the queue never drained');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function box(name: string): Promise<{ root: string; recordDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), `mdl-ui-workers-${name}-`));
  return { root, recordDir: path.join(root, 'run-records') };
}

async function cleanup(target: { root: string }): Promise<void> {
  await rm(target.root, { recursive: true, force: true });
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The form values on screen, from an analyze response — the whole run input. */
function formOf(analysis: { status: string; fields: readonly { key: string; value: string }[] }): Record<string, string> {
  assert.equal(analysis.status, 'parsed');
  const form = formValuesFromFields(analysis.fields as never) as Record<string, string>;
  assert.ok(Object.keys(form).length > 0, 'the fixture message analyzed into a usable form');
  return form;
}

// ------------------------------------------- 1. the duration end to end (HTTP)

test('each drained entry, its outcome record and its console row carry the run duration', async () => {
  const target = await box('duration');
  const { startUiServer } = await import('../../src/ui/server');
  const started = await startUiServer({
    port: 0,
    deps: { executor: fakeExecutor(CREATED_EXECUTOR_RESULT), recordDir: target.recordDir },
    auth: TEST_AUTH,
  });

  try {
    const analyzed = await post(`${started.url}/api/analyze`, { message: HAPPY_MESSAGE });
    assert.equal(analyzed.status, 200);
    const analysis = (await analyzed.json()) as { status: string; fields: Array<Record<string, unknown>> };
    const form = formOf(analysis);

    const stacked = await post(`${started.url}/api/run`, { message: HAPPY_MESSAGE, form, mode: 'create' });
    assert.equal(stacked.status, 200);
    const body = (await stacked.json()) as { status: string };
    assert.equal(body.status, 'enqueued', 'the POST answers at once; the duration arrives with the drain');

    const snapshot = await waitDrainedQueue(started.url);
    const entry = snapshot.entries[0];
    assert.equal(entry.state, 'creada', 'the worker drained the entry');
    assert.equal(entry.shipmentId, '#EM1055');
    assert.equal(entry.durationMs, 19_400, 'the entry carries the executor-measured duration');

    // The outcome record persists it (the create path writes it for both
    // modalities through this same writer).
    assert.ok(typeof entry.outcomePath === 'string' && entry.outcomePath.length > 0);
    const outcome = JSON.parse(await readFile(String(entry.outcomePath), { encoding: 'utf8' })) as {
      status: string;
      durationMs: number;
    };
    assert.equal(outcome.status, 'created');
    assert.equal(outcome.durationMs, 19_400, 'the outcome record persists the duration');

    // The console read — the workers panel's legacy rows — surfaces it too.
    const consoleSnapshot = await readConsole(resolveConsoleDeps({ recordDir: target.recordDir }));
    assert.equal(consoleSnapshot.runs.rows.length, 1);
    assert.equal(consoleSnapshot.runs.rows[0].shipmentId, '#EM1055');
    assert.equal(consoleSnapshot.runs.rows[0].durationMs, 19_400, 'the row carries the duration');
  } finally {
    await started.close();
    await cleanup(target);
  }
});

// ------------------------------------- 2. analyze is open during a single run

test('analyzing a new message works while a run holds the browser lock', async () => {
  const target = await box('single-flight');
  const { startUiServer } = await import('../../src/ui/server');

  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = await startUiServer({
    port: 0,
    deps: { executor: fakeExecutor(CREATED_EXECUTOR_RESULT, gate), recordDir: target.recordDir },
    auth: TEST_AUTH,
  });

  try {
    const analysis = (await (
      await post(`${started.url}/api/analyze`, { message: HAPPY_MESSAGE })
    ).json()) as { status: string; fields: Array<Record<string, unknown>> };

    // The run takes the lock and holds it inside the executor's journey.
    const runPromise = post(`${started.url}/api/run`, { message: HAPPY_MESSAGE, form: formOf(analysis), mode: 'create' });
    await delay(30);

    // The analyze POST is answered while the lock is held: pure parsing, no
    // browser, and the route was never behind the lock.
    const next = await post(`${started.url}/api/analyze`, { message: SECOND_MESSAGE });
    assert.equal(next.status, 200, 'analyze is answered during a run');
    const nextBody = (await next.json()) as { status: string; modalidad: string };
    assert.equal(nextBody.status, 'parsed');
    assert.equal(nextBody.modalidad, 'sucursal', 'the NEW message was parsed, not the running one');

    assert.ok(release);
    release();
    const runResponse = await runPromise;
    assert.equal(runResponse.status, 200);
    const runBody = (await runResponse.json()) as { status: string };
    assert.equal(runBody.status, 'enqueued', 'stacking never waits on the browser');

    // Once the gate released, the worker drained the entry the run POST stacked.
    const snapshot = await waitDrainedQueue(started.url);
    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.entries[0].state, 'creada');
  } finally {
    await started.close();
    await cleanup(target);
  }
});

// ------------------------------------------------------ 3. the desk's columns

test('the desk is two columns wide and stacks narrow, with no dialogs anywhere', () => {
  // The wide-screen desk grid: left column first, workers panel on the right.
  assert.match(PAGE_HTML, /class="desk"/);
  assert.match(PAGE_HTML, /class="col"/);
  assert.match(PAGE_HTML, /<aside class="workers" aria-label="Corridas recientes">/);
  assert.match(PAGE_HTML, /id="workers-list"/);
  // The rail dropped its Corridas block; the desk's media query stacks it.
  assert.equal(PAGE_HTML.includes('rail-runs-list'), false);
  assert.match(PAGE_HTML, /\.desk \{ grid-template-columns:1fr; gap:24px; \}/);

  // The operator's red sketch (v0.4.0): the workers panel sits beside the
  // message column at the same top edge — both columns pinned to grid row 1
  // with align-self:start, so nothing can float above-right again.
  assert.match(PAGE_HTML, /\.desk > \.col \{ grid-column:1; grid-row:1; align-self:start; min-width:0; \}/);
  assert.match(PAGE_HTML, /\.desk > \.workers \{ grid-column:2; grid-row:1; align-self:start; margin:0; min-width:0; \}/);

  // The queue note is next to the create button, in the page itself.
  assert.match(
    PAGE_HTML,
    /Los env\u00edos se crean de a uno \(un solo navegador\): pod\u00e9s encolar varios seguidos y el agente los crea solo, en orden\./,
  );

  // And the no-native-dialog rule still holds verbatim over both surfaces.
  for (const [name, source] of [['page', PAGE_HTML], ['client', CLIENT_JS]] as const) {
    for (const call of ['alert(', 'confirm(', 'prompt(']) {
      assert.equal(source.includes(call), false, `${name} must not contain ${call}`);
    }
  }
});

// ------------------------- 4. the client: enabled analyze, preview, workers

interface RunGate {
  /** Answers the pending `/api/run` POST with a 200 and this body. */
  settle(body: unknown, nextConsole?: unknown): void;
  /** Answers the pending `/api/run` POST with an HTTP error. */
  reject(status: number, body: { reason: string }): void;
}

interface Harness {
  node(id: string): FakeNode;
  fire(id: string, event: string): void;
  text(id: string): string;
  children(id: string): FakeNode[];
  runGate: RunGate;
  /** Replaces the snapshot the next `/api/queue` GET returns. */
  setQueue(snapshot: unknown): void;
  fetches: string[];
  /** Fires every live interval callback whose period is `ms` (all when absent). */
  tick(ms?: number): void;
  /** How many intervals are still scheduled. */
  timersLive(): number;
}

class FakeNode {
  children: FakeNode[] = [];
  attrs = new Map<string, string>();
  listeners = new Map<string, (() => void)[]>();
  ownText = '';
  className: string | null = '';
  hidden = false;
  disabled = false;
  value = '';
  type = '';
  checked = false;

  constructor(
    readonly tagName: string,
    readonly id = '',
  ) {}

  appendChild(child: FakeNode): FakeNode {
    this.children.push(child);
    return child;
  }

  removeChild(child: FakeNode): FakeNode {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    return child;
  }

  get firstChild(): FakeNode | null {
    return this.children[0] ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  addEventListener(event: string, handler: () => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(handler);
    this.listeners.set(event, list);
  }

  fire(event: string): void {
    for (const handler of this.listeners.get(event) ?? []) handler();
  }

  querySelector(selector: string): FakeNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeNode[] {
    if (selector === '[data-key]') return this.descendants().filter((node) => node.attrs.has('data-key'));
    return [];
  }

  descendants(): FakeNode[] {
    const out: FakeNode[] = [];
    const walk = (node: FakeNode): void => {
      node.children.forEach((child) => {
        out.push(child);
        walk(child);
      });
    };
    walk(this);
    return out;
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children = [];
  }
}

const EMPTY_CONSOLE = {
  readAt: '2026-01-01T00:00:00.000Z',
  session: { lastCheck: null, expiry: null },
  runs: { rows: [] },
  errors: { latest: null },
  warnings: [],
};

/** The console read after the run: the created run's own row, with its duration. */
const CONSOLE_WITH_ROW = {
  readAt: '2026-01-01T00:00:05.000Z',
  session: { lastCheck: null, expiry: null },
  runs: {
    rows: [
      {
        runId: '2026-02-01T02-06-40-000Z-000000000000',
        recordedAt: '2026-02-01T02:06:40.000Z',
        outcome: 'created',
        shipmentId: '#EM1055',
        durationMs: 19_400,
        unresolved: false,
      },
    ],
  },
  errors: { latest: null },
  warnings: [],
};

const QUEUED_ID = '000001-abc123def456';

const CREATED_BODY = {
  status: 'enqueued',
  queueId: QUEUED_ID,
  position: 1,
};

const EMPTY_QUEUE = {
  status: 'ok',
  readAt: '2026-01-01T00:00:00.000Z',
  entries: [],
  pending: 0,
  limit: 10,
  problems: [],
};

/** A queue entry as `/api/queue` projects it, with only the fields the client reads. */
function entryOf(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: QUEUED_ID,
    state: 'en-espera',
    modality: 'domicilio',
    enqueuedAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    shipmentId: null,
    durationMs: null,
    reason: null,
    recordPath: null,
    outcomePath: null,
    reportPath: null,
    stage: null,
    ...overrides,
  };
}

function queueOf(...entries: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    status: 'ok',
    readAt: '2026-01-01T00:00:00.000Z',
    entries,
    pending: entries.filter((entry) => entry.state === 'en-espera' || entry.state === 'en-proceso').length,
    limit: 10,
    problems: [],
  };
}

const delayFlush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

/** Boots the real client with the first message analyzed and a run in flight. */
async function boot(): Promise<Harness> {
  const registry = new Map<string, FakeNode>();
  const navigated: string[] = [];

  const node = (id: string): FakeNode => {
    let found = registry.get(id);
    if (found === undefined) {
      found = new FakeNode('div', id);
      registry.set(id, found);
    }
    return found;
  };

  const firstAnalysis = analyzeMessage(HAPPY_MESSAGE);
  assert.equal(firstAnalysis.status, 'parsed');
  const secondAnalysis = analyzeMessage(SECOND_MESSAGE);
  assert.equal(secondAnalysis.status, 'parsed');

  let settleRun: ((response: unknown) => void) | null = null;
  const runPromise = new Promise<unknown>((resolve) => {
    settleRun = resolve;
  });

  let consoleData: unknown = EMPTY_CONSOLE;
  let queueSnapshot: unknown = EMPTY_QUEUE;
  const fetchLog: string[] = [];
  const fetchStub = async (url: string, init?: { body?: string }) => {
    fetchLog.push(url);
    if (url === '/api/console') return { status: 200, ok: true, json: async () => consoleData };
    if (url === '/api/queue') return { status: 200, ok: true, json: async () => queueSnapshot };
    if (url === '/api/analyze') {
      const message = JSON.parse(init?.body ?? '{}')['message'];
      const analysis = message === SECOND_MESSAGE ? secondAnalysis : firstAnalysis;
      return { status: 200, ok: true, json: async () => analysis };
    }
    if (url === '/api/run') return await runPromise;
    throw new Error(`unexpected fetch: ${url}`);
  };

  // The client keeps up to two timers (the ~3 s queue poll and the ~2 s
  // re-render of an in-flight card), so the fake clock is a map of live
  // intervals keyed by id, exactly like the real one.
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextId = 1;
  const fakeSetInterval = (fn: () => void, ms: number) => {
    const id = nextId;
    nextId += 1;
    timers.set(id, { fn, ms });
    return id;
  };
  const fakeClearInterval = (id: number) => {
    timers.delete(id);
  };

  const fakeDocument = {
    documentElement: new FakeNode('html'),
    getElementById: node,
    createElement: (tag: string) => new FakeNode(tag),
    location: { assign: (url: string) => navigated.push(url) },
  };

  const run = new Function(
    'document',
    'fetch',
    'localStorage',
    'matchMedia',
    'setInterval',
    'clearInterval',
    CLIENT_JS,
  );
  run(
    fakeDocument,
    fetchStub,
    { getItem: () => null, setItem: () => undefined },
    undefined,
    fakeSetInterval,
    fakeClearInterval,
  );

  const flush = async (): Promise<void> => {
    for (let turn = 0; turn < 6; turn += 1) await delay(5);
  };

  await flush();

  node('message').value = HAPPY_MESSAGE;
  node('analyze').fire('click');
  await flush();

  node('create').fire('click');
  await flush();

  return {
    node,
    fire: (id, event) => node(id).fire(event),
    text: (id) => node(id).textContent,
    children: (id) => node(id).children,
    runGate: {
      settle: (body, nextConsole) => {
        if (nextConsole !== undefined) consoleData = nextConsole;
        settleRun!({ status: 200, ok: true, json: async () => body });
      },
      reject: (status, body) =>
        settleRun!({ status, ok: false, text: async () => JSON.stringify(body) }),
    },
    setQueue: (snapshot: unknown) => {
      queueSnapshot = snapshot;
    },
    fetches: fetchLog,
    tick: (ms?: number) => {
      for (const timer of [...timers.values()]) {
        if (ms === undefined || timer.ms === ms) timer.fn();
      }
    },
    timersLive: () => timers.size,
  };
}

test('during a run: Analizar stays enabled, Crear explains the wait, and the in-flight worker card is first', async () => {
  const page = await boot();

  // The entry is already on the queue and running when the POST is accepted:
  // the response is the instant `enqueued`, and the panel carries the entry.
  page.setQueue(queueOf(entryOf({ state: 'en-proceso', startedAt: new Date(Date.now() - 200).toISOString() })));
  page.runGate.settle(CREATED_BODY);
  await delayFlush();

  assert.equal(page.node('analyze').disabled, false, 'Analizar is never locked');
  assert.equal(page.node('create').disabled, true, 'with the form cleared by the enqueue, Crear waits for the next analyze');

  // The entry being created is the first worker card, with the estimate from
  // the journey steps and its own start instant.
  const workers = page.children('workers-list');
  assert.ok(workers.length >= 1);
  const inFlight = workers[0];
  assert.match(inFlight.className, /in-flight/);
  assert.match(inFlight.textContent, /— · en proceso · \d{2}:\d{2}/);
  assert.match(inFlight.textContent, /Progreso estimado: 0 % \(aproximado\)/);
});

test('analyzing the next message while a run is in flight renders its preview and keeps the in-flight card', async () => {
  const page = await boot();
  page.setQueue(queueOf(entryOf({ state: 'en-proceso', startedAt: new Date(Date.now() - 200).toISOString() })));
  page.runGate.settle(CREATED_BODY);
  await delayFlush();
  const readsBefore = page.fetches.filter((url) => url === '/api/analyze').length;

  page.node('message').value = SECOND_MESSAGE;
  page.fire('analyze', 'click');
  await delayFlush();

  // The fetch was answered: one more analyze than the boot's own.
  assert.equal(page.fetches.filter((url) => url === '/api/analyze').length, readsBefore + 1);

  // The preview for the NEXT shipment is on screen: the sucursal field set.
  const keys = page.node('shipment-form').querySelectorAll('[data-key]');
  assert.ok(keys.length > 0, 'the analyzed fields rendered while a run is in flight');
  assert.ok(keys.some((node) => node.getAttribute('data-key') === 'sucursal'), 'the next message is a sucursal one');
  assert.match(page.text('data-badge'), /editable/);

  // The in-flight card is untouched by the analyze: it is still on the panel.
  assert.ok(
    page.node('workers-list').descendants().some((node) => (node.className ?? '').includes('progress-steps')),
    'the in-flight card survives the analyze',
  );
  assert.match(page.children('workers-list')[0].textContent, /en proceso/);
});

test('the in-flight worker card advances with the progress tick', async () => {
  const page = await boot();
  page.setQueue(queueOf(entryOf({ state: 'en-proceso', startedAt: new Date(Date.now() - 200).toISOString() })));
  page.runGate.settle(CREATED_BODY);
  await delayFlush();

  // The poll refreshes the card's data; the ~2s timer re-renders it. Moving the
  // entry's own start instant is how a tick moves the estimate: one step per
  // two seconds of elapsed run.
  page.setQueue(queueOf(entryOf({ state: 'en-proceso', startedAt: new Date(Date.now() - 2_500).toISOString() })));
  page.tick(3_000);
  await delayFlush();
  assert.match(page.children('workers-list')[0].textContent, /Progreso estimado: 14 % \(aproximado\)/);

  page.setQueue(queueOf(entryOf({ state: 'en-proceso', startedAt: new Date(Date.now() - 6_500).toISOString() })));
  page.tick(3_000);
  await delayFlush();
  assert.match(page.children('workers-list')[0].textContent, /Progreso estimado: 43 % \(aproximado\)/);
});

test('when the poll reports the outcome the card shows the true duration and the worker list snaps to the finished row', async () => {
  const page = await boot();

  // The operator analyzed the next message while the run was still in flight,
  // and the POST was answered while that preview waited.
  page.node('message').value = SECOND_MESSAGE;
  page.fire('analyze', 'click');
  await delayFlush();

  page.setQueue(queueOf(entryOf({ state: 'en-proceso', startedAt: new Date(Date.now() - 200).toISOString() })));
  page.runGate.settle(CREATED_BODY, CONSOLE_WITH_ROW);
  await delayFlush();

  // The poll now reports the real outcome of the entry.
  page.setQueue(
    queueOf(
      entryOf({
        state: 'creada',
        startedAt: '2026-02-01T02:06:40.000Z',
        finishedAt: '2026-02-01T02:07:00.000Z',
        shipmentId: '#EM1055',
        durationMs: 19_400,
        recordPath: 'run-records/2026-02-01T02-06-40-000Z-000000000000.json',
        outcomePath: 'run-records/2026-02-01T02-06-40-000Z-000000000000.outcome.json',
        reportPath: 'artifacts/executor-fixture/create-run.json',
      }),
    ),
  );
  page.tick(3_000);
  await delayFlush();
  await delayFlush();

  // The post-run card: the true duration as its final line, `Duracion: 19,4 s`.
  const text = page.text('result');
  assert.match(text, /Envío creado: #EM1055/);
  assert.match(text, /Duración: 19,4 s/);

  // The worker list snapped: no in-flight card, the finished row with its
  // duration.
  const workers = page.children('workers-list').map((node) => node.textContent);
  assert.equal(workers.some((line) => line.includes('en proceso')), false, 'the in-flight card is gone');
  assert.equal(workers.length, 1);
  assert.match(workers[0], /^#EM1055 · creada · \d{2}:\d{2} · 19s$/);

  // The prepared preview survived, and Crear is ready for the next message.
  assert.equal(page.node('message').value, SECOND_MESSAGE, 'the analyzed next message is still on screen');
  assert.equal(page.node('create').disabled, false, 'create is ready for the prepared message');
  assert.match(page.text('analyze-status'), /ya está listo para encolar/);
});

/**
 * Two things the operator asked for, as rendered tests.
 *
 * 1. **Feedback during the run.** "me gustaria que al crear el envio se mas
 *    feedback, que me va ya diciendo por que paso va" — while a queue entry is
 *    `en proceso` its worker card carries the journey's step checklist and an
 *    approximate percentage (the known `JOURNEY_STEPS` estimate, computed from
 *    the entry's own start instant and labelled `estimado`/`aproximado`). When a
 *    poll reports the real outcome, the page says so and the estimate stops:
 *    nothing says "creado" before the poll reports it. These tests run the real
 *    `CLIENT_JS` against a fake DOM with an injected clock, so what is asserted
 *    is what the operator sees.
 * 2. **Readable, contained errors.** "es muy feo ese error encima todo salido
 *    del encuadre" — errors still render in tiers: one human heading, one
 *    actionable sentence, and the raw internals collapsed inside a `<details>`
 *    whose body wraps and scrolls inside its card. The hand-edit JSON recipe for
 *    resolving an unresolved record never reaches the screen; the record's file
 *    path does, and the recipe itself stays in docs/ops.
 *
 * Everything is offline and fictional (R11): invented messages, a stubbed
 * `fetch`, an injected clock. No browser, no panel, no network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeMessage } from '../../src/ui/actions';
import { CLIENT_JS, PAGE_HTML } from '../../src/ui/server';
import { JOURNEY_STEPS, approximatePercent } from '../../src/ui/progress';
import { HAPPY_MESSAGE, SUCURSAL_MESSAGE } from './fixtures';

// ------------------------------------------------------------- the fake DOM

/**
 * The slice of `Element` the client script uses. `textContent` reads the way a
 * reader sees a line: the node's own text followed by its descendants'.
 */
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

// ---------------------------------------------------------------- the harness

interface RunGate {
  /** Answers the pending `/api/run` POST with a 200 and this body. */
  settle(body: unknown): void;
  /** Answers the pending `/api/run` POST with an HTTP error. */
  reject(status: number, body: { status?: string; reason: string }): void;
}

interface Harness {
  node(id: string): FakeNode;
  fire(id: string, event: string): void;
  text(id: string): string;
  navigate(id: string): void;
  navigated: string[];
  runGate: RunGate;
  /** Replaces the snapshot the next `/api/queue` GET returns. */
  setQueue(snapshot: unknown): void;
  /** Every URL the client fetched, in order (the rail re-fetch assertions read this). */
  fetches: string[];
  /** Fires every live interval callback whose period is `ms` (all when absent). */
  tick(ms?: number): void;
  /** How many times the client cleared an interval. */
  clearCalls(): number;
  /** How many intervals are still scheduled. */
  timersLive(): number;
}

const CONSOLE_SNAPSHOT = {
  readAt: '2026-01-01T00:00:00.000Z',
  session: { lastCheck: null, expiry: null, checks: [], history: { path: 'history.json', unparseable: false } },
  runs: { rows: [] },
  errors: { latest: null },
  warnings: [],
};

const EMPTY_QUEUE = {
  status: 'ok',
  readAt: '2026-01-01T00:00:00.000Z',
  entries: [],
  pending: 0,
  limit: 10,
  problems: [],
};

function okResponse(body: unknown): unknown {
  return { status: 200, ok: true, json: async () => body };
}

function failResponse(status: number, body: unknown): unknown {
  return { status, ok: false, text: async () => JSON.stringify(body) };
}

/** Boots the real client script with the message pre-pasted and analyze run. */
async function boot(modality: 'domicilio' | 'sucursal'): Promise<Harness> {
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

  const message = modality === 'sucursal' ? SUCURSAL_MESSAGE : HAPPY_MESSAGE;
  const analysis = analyzeMessage(message);
  assert.equal(analysis.status, 'parsed');

  let settleRun: ((response: unknown) => void) | null = null;
  const runPromise = new Promise<unknown>((resolve) => {
    settleRun = resolve;
  });
  const runGate: RunGate = {
    settle: (body) => settleRun!(okResponse(body)),
    reject: (status, body) => settleRun!(failResponse(status, body)),
  };

  let queueSnapshot: unknown = EMPTY_QUEUE;
  const fetchLog: string[] = [];
  const fetchStub = async (url: string) => {
    fetchLog.push(url);
    if (url === '/api/console') return okResponse(CONSOLE_SNAPSHOT);
    if (url === '/api/analyze') return okResponse(analysis);
    if (url === '/api/queue') return okResponse(queueSnapshot);
    if (url === '/api/run') return await runPromise;
    throw new Error(`unexpected fetch: ${url}`);
  };

  // The client keeps up to two timers (the ~3 s queue poll and the ~2 s
  // re-render of an in-flight card), so the fake clock is a map of live
  // intervals keyed by id, exactly like the real one.
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextId = 1;
  let clears = 0;
  const fakeSetInterval = (fn: () => void, ms: number) => {
    const id = nextId;
    nextId += 1;
    timers.set(id, { fn, ms });
    return id;
  };
  const fakeClearInterval = (id: number) => {
    clears += 1;
    timers.delete(id);
  };

  const fakeDocument = {
    documentElement: new FakeNode('html'),
    getElementById: node,
    createElement: (tag: string) => new FakeNode(tag),
    location: {
      assign: (url: string) => {
        navigated.push(url);
      },
    },
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
    for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  };

  await flush();

  node('message').value = message;
  node('analyze').fire('click');
  await flush();

  node('create').fire('click');
  await flush();

  return {
    node,
    fire: (id, event) => node(id).fire(event),
    text: (id) => node(id).textContent,
    navigated,
    runGate,
    setQueue: (snapshot: unknown) => {
      queueSnapshot = snapshot;
    },
    fetches: fetchLog,
    tick: (ms?: number) => {
      for (const timer of [...timers.values()]) {
        if (ms === undefined || timer.ms === ms) timer.fn();
      }
    },
    clearCalls: () => clears,
    timersLive: () => timers.size,
  };
}

// ------------------------------------------------------------ result helpers

function resultCard(page: Harness): FakeNode {
  const result = page.node('result');
  const card = result.children[0];
  assert.ok(card, 'the page rendered one card into #result');
  assert.equal(card.className.split(' ')[0], 'result-card', 'every outcome is one contained card');
  return card;
}

function cardChild(card: FakeNode, className: string): FakeNode | null {
  return card.descendants().find((node) => (node.className ?? '').split(' ').includes(className)) ?? null;
}

function workersCard(page: Harness): FakeNode {
  const list = page.node('workers-list');
  const first = list.children[0];
  assert.ok(first, 'the queue rendered one worker card first');
  return first;
}

const QUEUED_ID = '000001-abc123def456';

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

function queueOf(...entries: Record<string, unknown>): Record<string, unknown> {
  return {
    status: 'ok',
    readAt: '2026-01-01T00:00:00.000Z',
    entries,
    pending: entries.filter((entry) => entry.state === 'en-espera' || entry.state === 'en-proceso').length,
    limit: 10,
    problems: [],
  };
}

const UNRESOLVED_RUN_ID = '2026-01-01T00-00-00-000Z-abcdefabcdef';

// --------------------------------------------------- 1. the progress estimate

test('the domicilio progress card shows the seven journey steps and an approximate percentage', async () => {
  const page = await boot('domicilio');

  // The entry is on the server: `en proceso`, started just now. The POST
  // answered `enqueued` the moment it was stacked; the card lives on the panel.
  page.setQueue(queueOf(entryOf({ state: 'en-proceso', startedAt: new Date(Date.now() - 200).toISOString() })));
  page.runGate.settle({ status: 'enqueued', queueId: QUEUED_ID, position: 1 });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const card = workersCard(page);
  assert.match(card.className, /in-flight/, 'the entry being created is the first worker card');
  assert.match(card.textContent, /Creando el envío/, 'the journey step labels are on screen');
  assert.match(card.textContent, /aproximado/, 'the estimate is labelled as such');

  const list = cardChild(card, 'progress-steps');
  assert.ok(list);
  assert.equal(list!.children.length, JOURNEY_STEPS.domicilio.length, 'one row per journey step');
  assert.equal(list!.children.length, 7, 'domicilio walks seven steps');
  assert.deepEqual(
    list!.children.map((row) => row.textContent),
    JOURNEY_STEPS.domicilio.map((label, index) => (index === 0 ? '⏳ ' : '· ') + label),
    'every step is on screen with its label; the first is in flight, the rest pending',
  );
  assert.equal(list!.children[0].className, 'current', 'the first step is the current one');
  assert.equal(list!.children[1].className, 'pending');
  assert.equal(list!.children[6].className, 'pending');

  assert.match(card.textContent, /Progreso estimado: 0 % \(aproximado\)/);
  assert.equal(page.timersLive(), 2, 'the poll and the progress re-render are both scheduled');

  // One poll (the snapshot now says two seconds have elapsed): the second step
  // becomes current and the percentage moves. The poll is what refreshes the
  // card's data; the ~2s timer only re-renders the same snapshot. Every
  // re-render rebuilds the list, so the card is read again from the panel.
  page.setQueue(queueOf(entryOf({ state: 'en-proceso', startedAt: new Date(Date.now() - 2_500).toISOString() })));
  page.tick(3_000);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const advancedCard = workersCard(page);
  assert.match(advancedCard.textContent, /Progreso estimado: 14 % \(aproximado\)/);
  assert.equal(approximatePercent(1, 7), 14);
  assert.equal(cardChild(advancedCard, 'progress-steps')!.children[1].className, 'current', 'the second step is now in flight');

  // Ticking to the cap: the last step stays current and the number stays below 100.
  page.setQueue(queueOf(entryOf({ state: 'en-proceso', startedAt: new Date(Date.now() - 13_000).toISOString() })));
  page.tick(3_000);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const cappedCard = workersCard(page);
  assert.match(cappedCard.textContent, /Progreso estimado: 86 % \(aproximado\)/);
  assert.equal(approximatePercent(6, 7), 86);
  assert.equal(cappedCard.textContent.includes('100 %'), false, 'the estimator never claims the run is done');
  const lastRow = cardChild(cappedCard, 'progress-steps')!.children[6];
  assert.equal(lastRow!.className, 'current', 'the last step is in flight, never done');
  assert.equal(page.clearCalls(), 0, 'the timers are still running: the entry is not settled yet');
});

test('the sucursal progress card shows the six journey steps with the same rules', async () => {
  const page = await boot('sucursal');

  page.setQueue(
    queueOf(entryOf({ state: 'en-proceso', modality: 'sucursal', startedAt: new Date(Date.now() - 200).toISOString() })),
  );
  page.runGate.settle({ status: 'enqueued', queueId: QUEUED_ID, position: 1 });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const list = cardChild(workersCard(page), 'progress-steps');
  assert.ok(list);
  assert.equal(list!.children.length, JOURNEY_STEPS.sucursal.length);
  assert.equal(list!.children.length, 6, 'sucursal walks six steps');
  assert.match(page.text('workers-list'), /Seleccionando Andreani a sucursal/);
  assert.match(page.text('workers-list'), /Seleccionando la sucursal/);

  page.setQueue(
    queueOf(entryOf({ state: 'en-proceso', modality: 'sucursal', startedAt: new Date(Date.now() - 2_500).toISOString() })),
  );
  page.tick(3_000);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(page.text('workers-list'), /Progreso estimado: 17 % \(aproximado\)/);
  assert.equal(approximatePercent(1, 6), 17);
  page.setQueue(
    queueOf(entryOf({ state: 'en-proceso', modality: 'sucursal', startedAt: new Date(Date.now() - 11_000).toISOString() })),
  );
  page.tick(3_000);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(page.text('workers-list'), /Progreso estimado: 83 % \(aproximado\)/);
  assert.equal(page.text('workers-list').includes('100 %'), false);
});

// --------------------------------------------- 2. the snap to the real answer

test('when the poll reports the outcome the card snaps to the created state and stops the estimate', async () => {
  const page = await boot('domicilio');

  page.setQueue(queueOf(entryOf({ state: 'en-proceso', startedAt: new Date(Date.now() - 2_500).toISOString() })));
  page.runGate.settle({ status: 'enqueued', queueId: QUEUED_ID, position: 1 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  page.tick(2_000);
  assert.equal(page.timersLive(), 2, 'the estimate is running while the entry is in flight');

  // The poll now reports the real outcome of the very same entry.
  page.setQueue(
    queueOf(
      entryOf({
        state: 'creada',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:19.400Z',
        shipmentId: '#EM1055',
        durationMs: 19_400,
        recordPath: `run-records/${UNRESOLVED_RUN_ID}.json`,
        outcomePath: `run-records/${UNRESOLVED_RUN_ID}.outcome.json`,
        reportPath: 'executor-fixture/create-run.json',
      }),
    ),
  );
  page.tick(3_000);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const text = page.text('result');
  assert.match(text, /Envío creado: #EM1055/, 'the big line, from the poll');
  assert.match(text, /Duración: 19,4 s/, 'the duration the entry carried');
  assert.equal(text.includes('aproximado'), false, 'no estimate survives the real answer');
  assert.equal(cardChild(resultCard(page), 'progress-steps'), null, 'the checklist is gone');
  assert.equal(page.timersLive(), 0, 'both timers were stopped');
  assert.ok(page.clearCalls() >= 2, 'the intervals were cleared, not left running');
  assert.deepEqual(page.navigated, [], 'a created entry does not navigate anywhere');

  // The worker list snapped to the finished row, with its short duration.
  assert.match(page.text('workers-list'), /^#EM1055 · creada · \d{2}:\d{2} · 19s/);
});

// --------------------------------------------------- 3. the error tiers

test('the unresolved refusal renders heading, action and collapsed details without the JSON recipe', async () => {
  const page = await boot('domicilio');
  page.setQueue(
    queueOf(
      entryOf({
        state: 'rechazada',
        finishedAt: '2026-01-01T00:00:02.000Z',
        reason: 'refused: a previous run for this message is attempted-unresolved (etapa: prior-attempt)',
        recordPath: `run-records/${UNRESOLVED_RUN_ID}.json`,
        outcomePath: `run-records/${UNRESOLVED_RUN_ID}.outcome.json`,
      }),
    ),
  );
  page.runGate.settle({ status: 'enqueued', queueId: QUEUED_ID, position: 1 });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const card = resultCard(page);
  assert.equal(cardChild(card, 'error-heading')!.textContent, 'Este mensaje ya tiene una corrida sin resolver.');
  assert.match(
    cardChild(card, 'error-action')!.textContent,
    /^Qué podés hacer: Revisá el panel y, si el envío no existe, marcá la corrida como resuelta\.$/,
    'one actionable sentence, written for the operator',
  );

  const details = card.descendants().find((node) => node.tagName === 'details');
  assert.ok(details, 'the technical stuff is collapsed inside <details>');
  const summary = details!.children.find((node) => node.tagName === 'summary');
  assert.equal(summary!.textContent, 'Detalles técnicos');
  const body = cardChild(card, 'error-detail-body');
  assert.ok(body, 'the details have a scrollable body');

  const shown = body!.textContent;
  // The raw internals are demoted, not removed: the run id and the file path.
  assert.match(shown, new RegExp(UNRESOLVED_RUN_ID));
  assert.match(shown, new RegExp(`run-records/${UNRESOLVED_RUN_ID}\\.outcome\\.json`), 'the file path survives');
  assert.match(shown, /attempted-unresolved/, 'the raw reason is in the details');

  // The hand-edit JSON recipe never reaches the screen, in the main flow or in details.
  const whole = page.text('result');
  assert.equal(whole.includes('"runId"'), false, 'no JSON recipe on screen');
  assert.equal(whole.includes('"status":"not-created"'), false);
  assert.equal(whole.includes('human resolution:'), false);

  assert.equal(page.timersLive(), 0, 'the estimators stopped: nothing is in flight');
  assert.match(page.text('run-status'), /no se creó/);
});

test('a duplicate-shipment refusal gets its own heading and action', async () => {
  const page = await boot('domicilio');
  page.setQueue(
    queueOf(
      entryOf({
        state: 'rechazada',
        finishedAt: '2026-01-01T00:00:02.000Z',
        reason: 'refused: this message already created a shipment (#EM1053) (etapa: prior-attempt)',
        recordPath: `run-records/${UNRESOLVED_RUN_ID}.json`,
      }),
    ),
  );
  page.runGate.settle({ status: 'enqueued', queueId: QUEUED_ID, position: 1 });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const card = resultCard(page);
  assert.equal(cardChild(card, 'error-heading')!.textContent, 'Este mensaje ya creó un envío.');
  assert.match(cardChild(card, 'error-action')!.textContent, /cambiá el mensaje para que sea un pedido distinto/);
  assert.match(card.textContent, /#EM1053/, 'the existing shipment is named in the details');
});

test('a failed run names the problem, the open record and keeps the raw reason collapsed', async () => {
  const page = await boot('domicilio');
  page.setQueue(
    queueOf(
      entryOf({
        state: 'fallida',
        finishedAt: '2026-01-01T00:00:02.000Z',
        reason: 'ExecutorError: screen 3 (Completar datos del destinatario): the form no longer holds the values just written',
        recordPath: `run-records/${UNRESOLVED_RUN_ID}.json`,
        outcomePath: null,
      }),
    ),
  );
  page.runGate.settle({ status: 'enqueued', queueId: QUEUED_ID, position: 1 });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const card = resultCard(page);
  assert.equal(cardChild(card, 'error-heading')!.textContent, 'No se pudo crear el envío.');
  assert.match(
    cardChild(card, 'error-action')!.textContent,
    /resolvé la corrida que quedó abierta/,
    'the actionable sentence matches the failure kind: a record was already written',
  );

  const body = cardChild(card, 'error-detail-body')!;
  assert.match(body.textContent, new RegExp(`run-records/${UNRESOLVED_RUN_ID}\\.json`), 'the record path is in the details');
  assert.match(body.textContent, /the form no longer holds the values/, 'the raw reason is demoted, not removed');
  assert.equal(page.text('result').includes('"runId"'), false);
});

test('a pre-click abort renders its own tier: nothing was created and the retry is free', async () => {
  const page = await boot('domicilio');
  page.setQueue(
    queueOf(
      entryOf({
        state: 'sin-crear',
        finishedAt: '2026-01-01T00:00:02.000Z',
        stage: 'journey to the summary (screens 1-4)',
        reason: 'PreClickAbortError: refusing to create the shipment: the panel does not hold the approved payload',
        recordPath: `run-records/${UNRESOLVED_RUN_ID}.json`,
        outcomePath: `run-records/${UNRESOLVED_RUN_ID}.outcome.json`,
      }),
    ),
  );
  page.runGate.settle({ status: 'enqueued', queueId: QUEUED_ID, position: 1 });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const card = resultCard(page);
  assert.equal(cardChild(card, 'error-heading')!.textContent, 'El envío no se creó.');
  assert.match(
    cardChild(card, 'error-action')!.textContent,
    /Podés repetir este mensaje cuando quieras/,
    'the actionable sentence matches the failure kind: nothing is open, no reconciliation needed',
  );

  const body = cardChild(card, 'error-detail-body')!;
  assert.match(body.textContent, /Etapa alcanzada: journey to the summary/, 'the stage reached is named');
  assert.match(body.textContent, new RegExp(`run-records/${UNRESOLVED_RUN_ID}\\.json`), 'the record path is in the details');

  // R10 as amended: no resolve-the-record instruction where none applies.
  const whole = page.text('result');
  assert.equal(whole.includes('resolvé la corrida'), false);
  assert.equal(whole.includes('attempted-unresolved'), false);
});

test('an HTTP failure of the run POST itself gets the same tiers', async () => {
  const page = await boot('domicilio');
  // The queue full: the one 409 the POST can still answer with.
  page.runGate.reject(409, {
    status: 'queue-full',
    reason:
      'la cola de envíos está llena (10 esperando o en proceso): esperá un rato — los que ya cargaste se crean solos, de a uno — y volvé a cargar este mensaje',
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const card = resultCard(page);
  assert.equal(cardChild(card, 'error-heading')!.textContent, 'La cola de envíos está llena.');
  assert.match(cardChild(card, 'error-action')!.textContent, /los que cargaste se crean solos/);
  assert.match(cardChild(card, 'error-detail-body')!.textContent, /la cola de envíos está llena/);
  assert.match(page.text('run-status'), /No se encoló: la cola está llena\./);

  const second = await boot('domicilio');
  second.runGate.reject(500, { status: 'error', reason: 'boom' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const secondCard = resultCard(second);
  assert.equal(cardChild(secondCard, 'error-heading')!.textContent, 'No se pudo encolar el envío.');
  assert.match(cardChild(secondCard, 'error-detail-body')!.textContent, /código HTTP: 500/);
});

// ------------------------------------------------- 4. the containment styles

interface Rule {
  selector: string;
  body: string;
}

function rulesOf(html: string): Rule[] {
  const open = html.indexOf('<style>');
  const close = html.indexOf('</style>');
  const css = html.slice(open + '<style>'.length, close).replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null = pattern.exec(css);
  while (match !== null) {
    const selector = (match[1] ?? '').trim();
    if (selector !== '' && !selector.startsWith('@')) rules.push({ selector, body: match[2] ?? '' });
    match = pattern.exec(css);
  }
  return rules;
}

test('the page contains the containment rules the operator asked for', () => {
  const rules = new Map(rulesOf(PAGE_HTML).map((rule) => [rule.selector, rule.body]));

  const card = rules.get('.result-card');
  assert.ok(card, '.result-card exists');
  assert.match(card!, /overflow-wrap:anywhere/, 'long lines wrap inside the card');
  assert.match(card!, /min-width:0/, 'the card cannot push the grid wider');

  const body = rules.get('.error-detail-body');
  assert.ok(body, '.error-detail-body exists');
  assert.match(body!, /max-height:220px/, 'the raw reason area is bounded');
  assert.match(body!, /overflow-y:auto/, 'and scrolls internally instead of overflowing');
  assert.match(body!, /overflow-wrap:anywhere/);

  const result = rules.get('.inline-result');
  assert.ok(result, '.inline-result exists');
  assert.match(result!, /overflow-wrap:anywhere/, 'the result area itself contains its content');

  const badCard = rules.get('.result-card.is-bad');
  assert.ok(badCard, 'error cards are visually marked');
  assert.match(badCard!, /border-color:var\(--bad\)/);
});

// ------------------------------------------------------- 5. the fixed invariants

test('the client script still opens no native dialog and injects no markup', () => {
  for (const call of ['alert(', 'confirm(', 'prompt(', 'innerHTML', 'window.']) {
    assert.equal(CLIENT_JS.includes(call), false, `the client script must not contain ${call}`);
  }
  // The progress card and the error tiers are built with createElement/textContent.
  assert.match(CLIENT_JS, /createElement\('details'\)/, 'the technical block is a real <details>');
  assert.match(CLIENT_JS, /textContent/, 'every value is written as text');
});

// --------------------------------------------------------- 6. the queue flow

/**
 * The operator's request verbatim: "debería haber un sistema de encolación …
 * pongo uno analizo lo mando, ahí se me debería limpiar, mando otro y así y
 * abajo que se vayan encolando". Stacking clears the inputs right away — the
 * values live on the server now — and when a poll reports the entry's outcome
 * the confirmation is said out loud in the result area. The result card is not
 * touched by later polls; the next analyze is what clears it.
 */

function consoleReads(page: Harness): number {
  return page.fetches.filter((url) => url === '/api/console').length;
}

test('after the POST is accepted the inputs reset at once and the entry shows as en espera', async () => {
  const page = await boot('domicilio');
  const readsBeforeRun = consoleReads(page);

  page.setQueue(queueOf(entryOf({ state: 'en-espera' })));
  page.runGate.settle({ status: 'enqueued', queueId: QUEUED_ID, position: 1 });
  await new Promise((resolve) => setTimeout(resolve, 20));

  // The inputs are empty again immediately: the values live on the server now.
  assert.equal(page.node('message').value, '', 'the message textarea is cleared');
  assert.equal(page.text('message-badge'), 'sin datos', 'the badge follows the emptied message');
  assert.equal(
    page.node('shipment-form').querySelectorAll('[data-key]').length, 0,
    'the analyzed fields are gone from the form',
  );
  assert.equal(page.node('warnings').children.length, 0, 'the parser warnings are gone');
  assert.equal(page.node('rejection').children.length, 0);
  assert.equal(page.node('data-empty').hidden, false, 'the paste-a-message hint is back');
  assert.match(page.text('data-badge'), /sin analizar/, 'the preview badge is reset');
  assert.equal(page.node('create').disabled, true, 'create waits for the next analyze');
  assert.match(page.text('analyze-status'), /pegá el siguiente mensaje/, 'the queue state is named on screen');

  // The workers panel carries the stacked entry as waiting.
  const card = workersCard(page);
  assert.match(card.textContent, /en espera/, 'the stacked entry is the queue, on the panel');
  assert.equal(page.timersLive(), 1, 'the poll keeps running while something waits');

  // The entry is announced when a poll reports its outcome; the rail is
  // re-fetched so the new run shows below without a reload.
  page.setQueue(
    queueOf(
      entryOf({
        state: 'creada',
        startedAt: '2026-01-01T00:00:01.000Z',
        finishedAt: '2026-01-01T00:00:20.000Z',
        shipmentId: '#EM1055',
        durationMs: 19_400,
      }),
    ),
  );
  page.tick(3_000);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise((resolve) => setTimeout(resolve, 20));

  // The confirmation is on screen and stays: a later poll never wipes it.
  assert.match(page.text('result'), /Envío creado: #EM1055/);
  assert.ok(consoleReads(page) > readsBeforeRun, 'the rail data was re-fetched after the outcome');
});

test('an entry the queue refused leaves the form as-is so the operator can fix and retry', async () => {
  const page = await boot('domicilio');

  // The one refusal the POST itself can still answer with: the posted values do
  // not build a payload, so nothing was stacked at all.
  page.runGate.settle({
    status: 'invalid-form',
    errors: [{ field: 'name', message: '«Nombre» es obligatorio' }],
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  // The card is on screen, with the field the operator must fix.
  const card = resultCard(page);
  assert.match(card.textContent, /No se encoló nada: revisá estos campos\./);
  assert.match(card.textContent, /«Nombre» es obligatorio/);
  assert.match(page.text('run-status'), /El envío no se creó\./);

  // Nothing was cleared: the message and the analyzed fields are untouched.
  assert.equal(page.node('message').value, HAPPY_MESSAGE, 'the message is kept for a fix-and-retry');
  assert.ok(
    page.node('shipment-form').querySelectorAll('[data-key]').length > 0,
    'the analyzed fields are still on the form',
  );
  assert.equal(page.node('data-empty').hidden, true, 'the analyzed preview stays (the hint stays hidden)');
});

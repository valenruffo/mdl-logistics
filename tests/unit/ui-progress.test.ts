/**
 * The two things the operator asked for after the failed run, as rendered tests.
 *
 * 1. **Feedback during the run.** "me gustaria que al crear el envio se mas
 *    feedback, que me va ya diciendo por que paso va" — the page now shows a
 *    progress card with the journey's step checklist per modality and an
 *    approximate percentage. The POST answers only at the end, so the card runs
 *    on a timer over the known step count and is labelled `estimado` /
 *    `aproximado`; when the response arrives the card snaps to the real outcome.
 *    These tests run the real `CLIENT_JS` against a fake DOM with an injected
 *    clock, so what is asserted is what the operator sees.
 * 2. **Readable, contained errors.** "es muy feo ese error encima todo salido
 *    del encuadre" — errors now render in tiers: one human heading, one
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

import { humanResolutionHint } from '../../src/cli/gates';
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
  reject(status: number, body: { reason: string }): void;
}

interface Harness {
  node(id: string): FakeNode;
  fire(id: string, event: string): void;
  text(id: string): string;
  navigated: string[];
  runGate: RunGate;
  /** Every URL the client fetched, in order (the rail re-fetch assertions read this). */
  fetches: string[];
  /** Fires the progress card's interval callback once (the injected clock). */
  tick(): void;
  /** How many times the client cleared its interval. */
  clearCalls(): number;
  /** Whether the progress interval is still scheduled. */
  timerLive(): boolean;
}

const CONSOLE_SNAPSHOT = {
  readAt: '2026-01-01T00:00:00.000Z',
  session: { lastCheck: null, expiry: null, checks: [], history: { path: 'history.json', unparseable: false } },
  runs: { rows: [] },
  errors: { latest: null },
  warnings: [],
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

  const fetchLog: string[] = [];
  const fetchStub = async (url: string) => {
    fetchLog.push(url);
    if (url === '/api/console') return okResponse(CONSOLE_SNAPSHOT);
    if (url === '/api/analyze') return okResponse(analysis);
    if (url === '/api/run') return await runPromise;
    throw new Error(`unexpected fetch: ${url}`);
  };

  let intervalCallback: (() => void) | null = null;
  let intervalMs: number | null = null;
  let clears = 0;
  const fakeSetInterval = (fn: () => void, ms: number) => {
    intervalCallback = fn;
    intervalMs = ms;
    return 77;
  };
  const fakeClearInterval = () => {
    clears += 1;
    intervalCallback = null;
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
    fetches: fetchLog,
    tick: () => {
      assert.ok(intervalCallback, 'the progress timer should still be scheduled');
      assert.equal(intervalMs, 2000, 'the progress timer ticks every two seconds');
      intervalCallback!();
    },
    clearCalls: () => clears,
    timerLive: () => intervalCallback !== null,
  };
}

// ------------------------------------------------------------ result helpers

function resultCard(page: Harness): FakeNode {
  const result = page.node('result');
  const card = result.children[0];
  assert.ok(card, 'the run rendered one card into #result');
  assert.equal(card.className.split(' ')[0], 'result-card', 'every outcome is one contained card');
  return card;
}

function cardChild(card: FakeNode, className: string): FakeNode | null {
  return card.descendants().find((node) => (node.className ?? '').split(' ').includes(className)) ?? null;
}

const CREATED_BODY = {
  status: 'created',
  shipmentId: '#EM1055',
  statusBadges: ['Por enviar', 'Envío manual'],
  cost: { summary: 'Andreani · Costo $ 1.234,00', detail: 'Costo $ 1.234,00' },
  labelUnpaid: { proven: true, problem: null, details: [] },
  reportPath: 'executor-fixture/create-run.json',
  detailScreenshot: null,
  recordPath: 'run-records/2026-01-01T00-00-00-000Z-abcdefabcdef.json',
  outcomePath: 'run-records/2026-01-01T00-00-00-000Z-abcdefabcdef.outcome.json',
};

const UNRESOLVED_RUN_ID = '2026-01-01T00-00-00-000Z-abcdefabcdef';

/** The refusal exactly as the prior-attempt gate raises it, JSON recipe included. */
const UNRESOLVED_REFUSAL = {
  status: 'refused',
  stage: 'prior-attempt',
  reason: 'refused: a previous run for this message is attempted-unresolved',
  details: [
    `run record ${UNRESOLVED_RUN_ID} (recorded 2026-01-01T00:00:00.000Z) was written before the create click and never recorded an outcome`,
    'the shipment may or may not exist, so this run is not retried automatically',
    'check the Envío Nube shipment list for this recipient by hand, then resolve the record as a human action',
    humanResolutionHint(UNRESOLVED_RUN_ID),
  ],
};

const FAILED_BODY = {
  status: 'failed',
  reason: 'ExecutorError: screen 3 (Completar datos del destinatario): the form no longer holds the values just written',
  details: ['screenshot captured: executor-fixture/failure.png', 'trace: executor-fixture/trace.zip'],
  recordPath: `run-records/${UNRESOLVED_RUN_ID}.json`,
  note: 'el registro queda attempted-unresolved a propósito: revisá la lista de envíos antes de repetir este mensaje',
};

/** A pre-click abort exactly as the run handler answers it (R10 as amended). */
const NOT_CREATED_BODY = {
  status: 'not-created',
  stage: 'journey to the summary (screens 1-4)',
  reason: 'PreClickAbortError: refusing to create the shipment: the panel does not hold the approved payload',
  details: ['zipCode: expected "1901", the panel holds "1902"'],
  recordPath: `run-records/${UNRESOLVED_RUN_ID}.json`,
  outcomePath: `run-records/${UNRESOLVED_RUN_ID}.outcome.json`,
  note: 'no se hizo ningún click: nada se creó. La corrida quedó resuelta como «sin crear» y este mensaje se puede repetir.',
};

// --------------------------------------------------- 1. the progress estimate

test('the domicilio progress card shows the seven journey steps and an approximate percentage', async () => {
  const page = await boot('domicilio');

  const card = resultCard(page);
  assert.match(card.textContent, /Creando el envío — progreso estimado/);
  assert.match(card.textContent, /aproximado/, 'the estimate is labelled as such');
  assert.match(card.textContent, /estimado/, 'and the wording says estimated, not measured');

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

  assert.match(page.text('result'), /Progreso estimado: 0 % \(aproximado\)/);
  assert.equal(page.timerLive(), true, 'the estimate runs while the POST is in flight');

  // One tick: the second step becomes current and the percentage moves.
  page.tick();
  assert.match(page.text('result'), /Progreso estimado: 14 % \(aproximado\)/);
  assert.equal(approximatePercent(1, 7), 14);

  // Ticking to the cap: the last step stays current and the number stays below 100.
  for (let tick = 0; tick < 10; tick += 1) page.tick();
  assert.match(page.text('result'), /Progreso estimado: 86 % \(aproximado\)/);
  assert.equal(approximatePercent(6, 7), 86);
  assert.equal(page.text('result').includes('100 %'), false, 'the timer never claims the run is done');
  const lastRow = list!.children[6];
  assert.equal(lastRow!.className, 'current', 'the last step is in flight, never done');
  assert.equal(page.clearCalls(), 0, 'the timer is still running: nothing is settled yet');
});

test('the sucursal progress card shows the six journey steps with the same rules', async () => {
  const page = await boot('sucursal');

  const list = cardChild(resultCard(page), 'progress-steps');
  assert.ok(list);
  assert.equal(list!.children.length, JOURNEY_STEPS.sucursal.length);
  assert.equal(list!.children.length, 6, 'sucursal walks six steps');
  assert.match(page.text('result'), /Seleccionando Andreani a sucursal/);
  assert.match(page.text('result'), /Seleccionando la sucursal/);

  page.tick();
  assert.match(page.text('result'), /Progreso estimado: 17 % \(aproximado\)/);
  assert.equal(approximatePercent(1, 6), 17);

  for (let tick = 0; tick < 10; tick += 1) page.tick();
  assert.match(page.text('result'), /Progreso estimado: 83 % \(aproximado\)/);
  assert.equal(page.text('result').includes('100 %'), false);
});

// --------------------------------------------- 2. the snap to the real answer

test('when the response arrives the card snaps to the created state and stops the estimate', async () => {
  const page = await boot('domicilio');
  page.tick();
  page.tick();

  page.runGate.settle(CREATED_BODY);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const text = page.text('result');
  assert.match(text, /Envío creado: #EM1055/, 'the big line, from the response');
  assert.match(text, /Costo \(resumen\): Andreani · Costo \$ 1\.234,00/, 'the cost the response carries');
  assert.match(text, /impaga/, 'the label-unpaid line');
  assert.equal(text.includes('aproximado'), false, 'no estimate survives the real answer');
  assert.equal(cardChild(resultCard(page), 'progress-steps'), null, 'the checklist is gone');
  assert.equal(page.timerLive(), false, 'the timer was stopped');
  assert.ok(page.clearCalls() >= 1, 'the interval was cleared, not left running');
  assert.deepEqual(page.navigated, [], 'a created run does not navigate anywhere');
});

// --------------------------------------------------- 3. the error tiers

test('the unresolved refusal renders heading, action and collapsed details without the JSON recipe', async () => {
  const page = await boot('domicilio');
  page.runGate.settle(UNRESOLVED_REFUSAL);
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

  assert.equal(page.timerLive(), false, 'the estimate stopped when the refusal arrived');
  assert.match(page.text('run-status'), /no se creó/);
});

test('a duplicate-shipment refusal gets its own heading and action', async () => {
  const page = await boot('domicilio');
  page.runGate.settle({
    status: 'refused',
    stage: 'prior-attempt',
    reason: 'refused: this message already created a shipment (#EM1053)',
    details: [`run record ${UNRESOLVED_RUN_ID} recorded the shipment #EM1053 as created`],
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const card = resultCard(page);
  assert.equal(cardChild(card, 'error-heading')!.textContent, 'Este mensaje ya creó un envío.');
  assert.match(cardChild(card, 'error-action')!.textContent, /cambiá el mensaje para que sea un pedido distinto/);
  assert.match(card.textContent, /#EM1053/, 'the existing shipment is named in the details');
});

test('a failed run names the problem, the open record and keeps the raw reason collapsed', async () => {
  const page = await boot('domicilio');
  page.runGate.settle(FAILED_BODY);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const card = resultCard(page);
  assert.equal(cardChild(card, 'error-heading')!.textContent, 'No se pudo crear el envío.');
  assert.match(
    cardChild(card, 'error-action')!.textContent,
    /resolvé la corrida que quedó abierta/,
    'the actionable sentence matches the failure kind: a record was already written',
  );

  const body = cardChild(card, 'error-detail-body')!;
  assert.match(body.textContent, new RegExp(FAILED_BODY.recordPath.replaceAll('.', '\\.')), 'the record path is in the details');
  assert.match(body.textContent, /the form no longer holds the values/, 'the raw reason is demoted, not removed');
  assert.equal(page.text('result').includes('"runId"'), false);
});

test('a pre-click abort renders its own tier: nothing was created and the retry is free', async () => {
  const page = await boot('domicilio');
  page.runGate.settle(NOT_CREATED_BODY);
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
  assert.match(body.textContent, new RegExp(NOT_CREATED_BODY.recordPath.replaceAll('.', '\\.')), 'the record path is in the details');

  // R10 as amended: no resolve-the-record instruction where none applies.
  const whole = page.text('result');
  assert.equal(whole.includes('resolvé la corrida'), false);
  assert.equal(whole.includes('attempted-unresolved'), false);
});

test('an HTTP failure of the run POST itself gets the same tiers', async () => {
  const page = await boot('domicilio');
  page.runGate.reject(409, { status: 'busy', reason: 'ya hay una corrida en curso en este proceso' });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const card = resultCard(page);
  assert.equal(cardChild(card, 'error-heading')!.textContent, 'Hay otra corrida en curso.');
  assert.match(cardChild(card, 'error-action')!.textContent, /Esperá a que termine y volvé a intentar/);
  assert.match(cardChild(card, 'error-detail-body')!.textContent, /ya hay una corrida en curso/);

  const second = await boot('domicilio');
  second.runGate.reject(500, { status: 'error', reason: 'boom' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const secondCard = resultCard(second);
  assert.equal(cardChild(secondCard, 'error-heading')!.textContent, 'No se pudo completar la corrida.');
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

// --------------------------------------------------------- 6. the queue loop

/**
 * The operator's request verbatim: "debería haber un sistema de encolación …
 * pongo uno analizo lo mando, ahí se me debería limpiar, mando otro y así y
 * abajo que se vayan encolando". After a confirmed `created` only the inputs
 * reset — the result card keeps the `#EM` — and after any response the rail is
 * re-fetched so the new run shows up below without a reload.
 */

function consoleReads(page: Harness): number {
  return page.fetches.filter((url) => url === '/api/console').length;
}

test('after a created run the inputs reset and the confirmation stays on screen', async () => {
  const page = await boot('domicilio');
  const readsBeforeRun = consoleReads(page);

  page.runGate.settle(CREATED_BODY);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise((resolve) => setTimeout(resolve, 20));

  // The confirmation is not wiped: the result keeps the created #EM.
  assert.match(page.text('result'), /Envío creado: #EM1055/);

  // The inputs are empty again: the next message can be pasted right away.
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

  // The rail was re-fetched after the response: the new run shows below.
  assert.ok(consoleReads(page) > readsBeforeRun, 'the rail data was re-fetched after the created response');
});

test('after a refused run the form stays as-is so the operator can fix and retry', async () => {
  const page = await boot('domicilio');
  const readsBeforeRun = consoleReads(page);

  page.runGate.settle(UNRESOLVED_REFUSAL);
  await new Promise((resolve) => setTimeout(resolve, 20));

  // The refusal card is on screen.
  assert.match(page.text('result'), /Este mensaje ya tiene una corrida sin resolver\./);

  // Nothing was cleared: the message and the analyzed fields are untouched.
  assert.equal(page.node('message').value, HAPPY_MESSAGE, 'the message is kept for a fix-and-retry');
  assert.ok(
    page.node('shipment-form').querySelectorAll('[data-key]').length > 0,
    'the analyzed fields are still on the form',
  );
  assert.equal(page.node('data-empty').hidden, true, 'the analyzed preview stays (the hint stays hidden)');

  // The rail was re-fetched even on a refusal.
  assert.ok(consoleReads(page) > readsBeforeRun, 'the rail data was re-fetched after the refusal too');
});

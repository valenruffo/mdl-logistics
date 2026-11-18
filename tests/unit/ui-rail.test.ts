/**
 * The rail, as the operator reads it.
 *
 * The operator asked for the rail to stop explaining things: "es toda
 * información irrelevante que no me sirve… solo tiene que estar lo que sirva ver
 * ahí, o sea la sesión, corridas, errores y listo". The prose that used to sit in
 * it — the process-runtime table, the two "where each datum comes from" notes, the
 * artifact listing and its SSH instructions, the health paragraph and the
 * duration in milliseconds — is gone, and this file asserts it is gone from the
 * page, from the client script and from the `/api/console` snapshot.
 *
 * The rendering half runs the real `CLIENT_JS` against a tiny fake DOM and a
 * stubbed `fetch`, so the assertions are about the **text the operator sees**, not
 * about a substring of the source: the session word with its "verificada …" line
 * and the cookie expiry, one line per run, and the error word with at most one
 * line under it.
 *
 * Everything is offline and fictional (R11): no browser, no panel, no network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { readConsole, resolveConsoleDeps, type ConsoleDeps } from '../../src/ui/console';
import { APP_VERSION } from '../../src/ui/page';
import { CLIENT_JS, PAGE_HTML } from '../../src/ui/server';
import type { SessionCheckRunner } from '../../src/ui/sessionCheck';

// ------------------------------------------------------------- the fake DOM

/**
 * The slice of `Element` the client script uses. Text is kept apart from the
 * children so `textContent` can be *read* the way a reader sees the line: the
 * node's own text followed by its descendants'.
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

  querySelector(selector: string): FakeNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  /**
   * The only selector the rail asks for is its dot, `.b`. A dot is created on the
   * spot when the markup did not provide one, which is what the real page does.
   */
  querySelectorAll(selector: string): FakeNode[] {
    if (selector !== '.b') return [];
    let dot = this.children.find((child) => (child.className ?? '').split(' ').includes('b'));
    if (dot === undefined) {
      dot = new FakeNode('span');
      dot.className = 'b';
      this.children.push(dot);
    }
    return [dot];
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children = [];
  }
}

interface Rail {
  /** The text of one rail line, exactly as it is read. */
  text(id: string): string;
  /** The text of each child of a container, in order. */
  lines(id: string): string[];
  /** The dot's class list for a state block (`b ok`, `b warn`, `b bad`). */
  dotClass(id: string): string;
  /** How many children a container has. */
  count(id: string): number;
  /** The class list of a node (the rail's warning mark, for one). */
  className(id: string): string;
  navigated: string[];
}

/** Runs the real client script against the fake DOM and returns the rail. */
async function renderRail(snapshot: unknown): Promise<Rail> {
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

  const fakeFetch = async (url: string) => {
    assert.equal(url, '/api/console', 'the rail is fed only by GET /api/console');
    return { status: 200, ok: true, json: async () => snapshot };
  };

  const fakeStorage = {
    getItem: () => null,
    setItem: () => undefined,
  };

  const run = new Function('document', 'fetch', 'localStorage', 'matchMedia', CLIENT_JS);
  run(fakeDocument, fakeFetch, fakeStorage, undefined);

  // The console read is one fetch and a promise chain: give the microtasks a
  // couple of turns before reading the rendered text.
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 5));

  return {
    text: (id) => {
      const found = registry.get(id);
      assert.ok(found, `the rail rendered #${id}`);
      return found.textContent;
    },
    lines: (id) => {
      const found = registry.get(id);
      assert.ok(found, `the rail rendered #${id}`);
      return found.children.map((child) => child.textContent);
    },
    dotClass: (id) => {
      const found = registry.get(id);
      const dot = found?.children.find((child) => (child.className ?? '').includes('b'));
      return dot?.className ?? '';
    },
    count: (id) => registry.get(id)?.children.length ?? 0,
    className: (id) => registry.get(id)?.className ?? '',
    navigated,
  };
}

// ------------------------------------------------------------- the snapshot

interface Box {
  root: string;
  recordDir: string;
  artifactsDir: string;
  historyPath: string;
}

async function box(name: string): Promise<Box> {
  const root = await mkdtemp(path.join(tmpdir(), `mdl-rail-${name}-`));
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

function deps(target: Box): ConsoleDeps {
  return resolveConsoleDeps({
    recordDir: target.recordDir,
    artifactsDir: target.artifactsDir,
    sessionCheckHistoryPath: target.historyPath,
    sessionCheckRunner: forbiddenRunner(),
    processInfo: { pid: 4242, nodeVersion: 'v22.0.0', uptimeSeconds: 12, platform: 'linux', cwd: target.root },
  });
}

function forbiddenRunner(): SessionCheckRunner {
  return async () => {
    throw new Error('reading the rail never runs a session check');
  };
}

/** A run record pair, written the way the executor writes it. */
async function writeRun(
  target: Box,
  options: { runId: string; recordedAt: string; outcome: 'created' | 'unknown' | 'not-created' | null; shipmentId?: string },
): Promise<void> {
  await mkdir(target.recordDir, { recursive: true });
  const record = {
    runId: options.runId,
    recordedAt: options.recordedAt,
    messageHash: 'a'.repeat(64),
    approvalHash: 'b'.repeat(64),
    status: 'attempted-unresolved',
  };
  await writeFile(path.join(target.recordDir, `${options.runId}.json`), `${JSON.stringify(record)}\n`, {
    encoding: 'utf8',
  });

  if (options.outcome === null) return;
  await writeFile(
    path.join(target.recordDir, `${options.runId}.outcome.json`),
    `${JSON.stringify({
      runId: options.runId,
      finishedAt: options.recordedAt,
      status: options.outcome,
      shipmentId: options.shipmentId ?? null,
      reportPath: '',
    })}\n`,
    { encoding: 'utf8' },
  );
}

/** A local wall-clock instant, so `timeOf` renders the same in every time zone. */
function localTime(year: number, month: number, day: number, hour: number, minute: number): string {
  return new Date(year, month - 1, day, hour, minute).toISOString();
}

// ------------------------------------- 1. the removed prose is really gone

test('the explanatory prose is gone from the page, the client script and the snapshot', async () => {
  const target = await box('prose');
  try {
    // A snapshot with something in every block, so the assertion is not passing
    // just because the fixture was empty.
    const runId = '2026-02-01T05-57-00-000Z-aaaaaaaaaaaa';
    await writeRun(target, {
      runId,
      recordedAt: localTime(2026, 2, 1, 2, 57),
      outcome: 'created',
      shipmentId: '#EM1055',
    });
    await mkdir(path.join(target.artifactsDir, 'executor-fixture'), { recursive: true });
    await writeFile(
      path.join(target.artifactsDir, 'executor-fixture', 'create-run.json'),
      `${JSON.stringify({ formMatchesApproval: false, mismatches: ['x: y'], failedChecks: ['statusBadge'] })}\n`,
      { encoding: 'utf8' },
    );

    const snapshot = await readConsole(deps(target));
    const snapshotText = JSON.stringify(snapshot);

    const removedFromEverySurface = [
      'Runtime del proceso',
      'De dónde sale cada dato',
      'El informe completo, en disco',
      'Cómo se retiran',
      'Avisos de lectura',
      'ningún informe del ejecutor falló',
      'Si la sesión está utilizable',
      'ningún intento quedó abierto',
      'se retiran por SSH',
      'no se sirven por HTTP',
      'docker compose cp',
      'SSH',
    ];

    for (const [name, surface] of [
      ['the page', PAGE_HTML],
      ['the client script', CLIENT_JS],
      ['/api/console', snapshotText],
    ] as const) {
      for (const prose of removedFromEverySurface) {
        assert.equal(
          surface.toLowerCase().includes(prose.toLowerCase()),
          false,
          `${name} must not carry the removed prose "${prose}"`,
        );
      }
    }

    // The artifact block is gone as a block, not just relabelled.
    assert.doesNotMatch(PAGE_HTML, /id="rail-artifacts-heading"/);
    assert.doesNotMatch(PAGE_HTML, /id="rail-runtime"/);
    assert.doesNotMatch(PAGE_HTML, /id="rail-health"/);
    assert.doesNotMatch(PAGE_HTML, /<details/);
    assert.doesNotMatch(CLIENT_JS, /rail-artifacts|rail-runtime|rail-health|formatBytes/);

    // No duration beside the last check: the client no longer reads the number.
    assert.doesNotMatch(CLIENT_JS, /durationMs/);
    assert.doesNotMatch(CLIENT_JS, /' ms'/);
  } finally {
    await cleanup(target);
  }
});

// ------------------------------------------ 2. the rail with nothing to show

test('the rail renders with no runs and no errors: three blocks, no invented numbers', async () => {
  const target = await box('empty');
  try {
    const snapshot = await readConsole(deps(target));
    const rail = await renderRail(snapshot);

    // SESIÓN: the word, why it is not a yes, the button's status, and the expiry.
    assert.equal(rail.text('rail-session-text'), 'Sin chequeosnunca se verificó');
    assert.equal(rail.dotClass('rail-session-state'), 'b warn', 'a session nobody checked is a warn dot');
    assert.equal(rail.text('rail-expiry'), 'vence: desconocido');
    assert.doesNotMatch(rail.className('rail-expiry'), /warn/, 'an unknown expiry is not marked as soon');

    // CORRIDAS: one notice, no numbers.
    assert.equal(rail.count('rail-runs-list'), 1);
    assert.equal(rail.text('rail-runs-list'), 'no hay ningún run registrado todavía');

    // ERRORES: the word only.
    assert.equal(rail.text('rail-errors-text'), 'Ninguno');
    assert.equal(rail.dotClass('rail-errors-state'), 'b ok');
    assert.equal(rail.count('rail-errors-detail'), 0, 'no error, no line');

    // The footer: open attempts and the version.
    assert.equal(rail.text('rail-open'), 'sin abiertas');
    assert.ok(PAGE_HTML.includes(`v${APP_VERSION}`), 'the footer prints the package version');
    assert.deepEqual(rail.navigated, [], 'nothing redirected the page');
  } finally {
    await cleanup(target);
  }
});

// ------------------------------------------------------ 3. one line per run

test('the last five runs are one line each: #EM1055 · creada · 02:57', async () => {
  const target = await box('runs');
  try {
    const createdAt = localTime(2026, 2, 1, 2, 57);
    await writeRun(target, {
      runId: '2026-02-01T05-57-00-000Z-aaaaaaaaaaaa',
      recordedAt: createdAt,
      outcome: 'created',
      shipmentId: '#EM1055',
    });
    await writeRun(target, {
      runId: '2026-02-01T06-10-00-000Z-bbbbbbbbbbbb',
      recordedAt: localTime(2026, 2, 1, 3, 10),
      outcome: null,
    });
    // The open attempt is written last, so it is the newest record: it must still
    // be one of the five lines and read `sin desenlace`.
    await writeRun(target, {
      runId: '2026-02-01T08-00-00-000Z-ffffffffffff',
      recordedAt: localTime(2026, 2, 1, 5, 0),
      outcome: null,
    });
    await writeRun(target, {
      runId: '2026-02-01T06-20-00-000Z-cccccccccccc',
      recordedAt: localTime(2026, 2, 1, 3, 20),
      outcome: 'unknown',
    });
    await writeRun(target, {
      runId: '2026-02-01T06-30-00-000Z-dddddddddddd',
      recordedAt: localTime(2026, 2, 1, 3, 30),
      outcome: 'not-created',
    });
    for (let index = 0; index < 2; index += 1) {
      await writeRun(target, {
        runId: `2026-02-01T07-0${index}-00-000Z-eeeeeeeeeeee`,
        recordedAt: localTime(2026, 2, 1, 4, index),
        outcome: 'created',
        shipmentId: `#EM106${index}`,
      });
    }

    const snapshot = await readConsole(deps(target));
    const rail = await renderRail(snapshot);

    assert.equal(rail.count('rail-runs-list'), 5, 'the rail shows five runs, not every record');

    // Newest first, one line each: the identifier, the outcome word and the time.
    assert.deepEqual(rail.lines('rail-runs-list'), [
      '— · sin desenlace · 05:00',
      '#EM1061 · creada · 04:01',
      '#EM1060 · creada · 04:00',
      '— · sin crear · 03:30',
      '— · desconocida · 03:20',
    ]);
  } finally {
    await cleanup(target);
  }
});

// ----------------------------------------------- 4. the error block, trimmed

test('the error block shows the word only, and one line with the failing check and the time', async () => {
  const target = await box('errors');
  try {
    const dir = path.join(target.artifactsDir, 'executor-fixture');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'create-run.json'),
      `${JSON.stringify({
        failedChecks: ['statusBadge'],
        finishedAt: '2026-02-07T10:00:00.000Z',
      })}\n`,
      { encoding: 'utf8' },
    );

    const snapshot = await readConsole(deps(target));
    const rail = await renderRail(snapshot);

    assert.equal(rail.text('rail-errors-text'), 'Hay un informe con fallas');
    assert.equal(rail.dotClass('rail-errors-state'), 'b bad');
    assert.equal(rail.count('rail-errors-detail'), 1, 'a real failure is one line, not a list');
    assert.match(rail.text('rail-errors-detail'), /^status-badge · \d{2}:\d{2}$/);
    // No path, no report text, no explanation.
    assert.doesNotMatch(rail.text('rail-errors-detail'), /executor-fixture|create-run\.json|Villa Ejemplo/);
  } finally {
    await cleanup(target);
  }
});

// ------------------------------------------------------------- 5. the expiry

test('the expiry line reports days from the fixture cookie and never a cookie value', async () => {
  const target = await box('expiry');
  try {
    const stateFile = path.join(target.root, 'storage-state.json');
    const marker = 'COOKIE-VALUE-MUST-NEVER-BE-RENDERED';
    const expires = Math.floor(Date.now() / 1_000) + 12 * 86_400;
    await writeFile(
      stateFile,
      `${JSON.stringify({
        cookies: [{ name: 'admn_session', value: marker, domain: 'example.invalid', path: '/', expires }],
        origins: [],
      })}\n`,
      { encoding: 'utf8' },
    );

    const saved = process.env['MDL_STORAGE_STATE'];
    process.env['MDL_STORAGE_STATE'] = stateFile;
    try {
      const snapshot = await readConsole(deps(target));
      const rail = await renderRail(snapshot);

      assert.match(rail.text('rail-expiry'), /^vence en 1[12] días$/, rail.text('rail-expiry'));
      assert.doesNotMatch(rail.className('rail-expiry'), /warn/, 'twelve days out is not marked');
      assert.doesNotMatch(rail.text('rail-expiry'), new RegExp(marker));
      assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(marker), 'the value never leaves the server');
      assert.doesNotMatch(rail.text('rail-session-text'), /vence/, 'the expiry is its own line');
    } finally {
      if (saved === undefined) delete process.env['MDL_STORAGE_STATE'];
      else process.env['MDL_STORAGE_STATE'] = saved;
    }
  } finally {
    await cleanup(target);
  }
});

test('an expiry three days out is marked, and an absent or unreadable one says desconocido', async () => {
  const now = (): number => Math.floor(Date.now() / 1_000);

  const threeDays = await (async () => {
    const target = await box('expiry-soon');
    try {
      const stateFile = path.join(target.root, 'storage-state.json');
      await writeFile(
        stateFile,
        `${JSON.stringify({
          cookies: [{ name: 'admn_session', value: 'x', expires: now() + 3 * 86_400 }],
          origins: [],
        })}\n`,
        { encoding: 'utf8' },
      );
      const saved = process.env['MDL_STORAGE_STATE'];
      process.env['MDL_STORAGE_STATE'] = stateFile;
      try {
        return await readConsole(deps(target));
      } finally {
        if (saved === undefined) delete process.env['MDL_STORAGE_STATE'];
        else process.env['MDL_STORAGE_STATE'] = saved;
      }
    } finally {
      await cleanup(target);
    }
  })();

  const rail = await renderRail(threeDays);
  assert.match(rail.text('rail-expiry'), /^vence en [23] días$/);
  assert.match(rail.className('rail-expiry'), /warn/, 'three days out is marked');

  // The cookie is there but carries no expiry: unknown, never a guess.
  const withoutExpiry = await (async () => {
    const target = await box('expiry-none');
    try {
      const stateFile = path.join(target.root, 'storage-state.json');
      await writeFile(stateFile, `${JSON.stringify({ cookies: [{ name: 'admn_session', value: 'x' }], origins: [] })}\n`, {
        encoding: 'utf8',
      });
      const saved = process.env['MDL_STORAGE_STATE'];
      process.env['MDL_STORAGE_STATE'] = stateFile;
      try {
        return await readConsole(deps(target));
      } finally {
        if (saved === undefined) delete process.env['MDL_STORAGE_STATE'];
        else process.env['MDL_STORAGE_STATE'] = saved;
      }
    } finally {
      await cleanup(target);
    }
  })();

  const unknownRail = await renderRail(withoutExpiry);
  assert.equal(unknownRail.text('rail-expiry'), 'vence: desconocido');
  assert.doesNotMatch(unknownRail.className('rail-expiry'), /warn/);
});

// ------------------------------------------------- 6. the session word, kept

test('the session block keeps its dot, its word and a short "verificada" line', async () => {
  const target = await box('session');
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await mkdir(path.dirname(target.historyPath), { recursive: true });
    await writeFile(
      target.historyPath,
      `${JSON.stringify({
        version: 1,
        updatedAt: thirtyDaysAgo,
        checks: [
          {
            runAt: thirtyDaysAgo,
            result: 'usable',
            exitCode: 0,
            durationMs: 5_492,
            message: 'OK: la sesión es utilizable.',
            output: 'OK: la sesión es utilizable.',
            opensBrowser: true,
            spawnProblem: null,
          },
        ],
      })}\n`,
      { encoding: 'utf8' },
    );

    const snapshot = await readConsole(deps(target));
    const rail = await renderRail(snapshot);

    assert.equal(rail.text('rail-session-text'), 'Utilizableverificada hace 30 d');
    assert.equal(rail.dotClass('rail-session-state'), 'b ok');
    assert.doesNotMatch(rail.text('rail-session-text'), /5492|ms|código/, 'no duration, no exit code');

    // The dot is decorative; the word next to it carries the state, and the
    // button that can re-check is still there.
    assert.match(PAGE_HTML, /<span class="b" aria-hidden="true"><\/span>\s*<span id="rail-session-text">/);
    assert.match(PAGE_HTML, /<button type="button" id="session-check-run">Verificar ahora<\/button>/);

    // A recent check is a relative time, not a duration.
    const fresh = await renderRail({
      ...snapshot,
      session: {
        ...snapshot.session,
        lastCheck: { runAt: new Date().toISOString(), result: 'unusable', exitCode: 1, durationMs: 5_492 },
      },
    });
    assert.equal(fresh.text('rail-session-text'), 'No utilizableverificada hace 1 min');
    assert.equal(fresh.dotClass('rail-session-state'), 'b bad');
  } finally {
    await cleanup(target);
  }
});

// ----------------------------------------------------- 7. the rail's trim

test('the brand and the theme toggle share one discreet line, and focus stays visible', () => {
  const railStart = PAGE_HTML.indexOf('<aside class="rail"');
  const railEnd = PAGE_HTML.indexOf('</aside>');
  const headAt = PAGE_HTML.indexOf('class="rail-head"');
  const toggleAt = PAGE_HTML.indexOf('id="theme-toggle"');

  assert.ok(railStart >= 0 && railEnd > railStart);
  assert.ok(headAt > railStart && headAt < railEnd, 'the brand line lives at the top of the rail');
  assert.ok(toggleAt > headAt && toggleAt < railEnd, 'the toggle sits on that same line');

  // Small and quiet: not the full-width control the rest of the rail uses.
  assert.match(PAGE_HTML, /\.rail button\.rail-toggle \{[^}]*width:auto/, 'the toggle is not a full-width button');
  assert.match(PAGE_HTML, /\.rail button\.rail-toggle \{[^}]*font-size:10\.5px/, 'the toggle is small');
  assert.match(PAGE_HTML, /\.rail-head \{[^}]*display:flex/, 'brand and toggle share one row');

  // Accessibility: the dots are aria-hidden and always carry a word, and the
  // focus ring of the rail is declared.
  const dots = PAGE_HTML.split('<span class="b" aria-hidden="true">').length - 1;
  assert.ok(dots >= 2, `every state block declares its dot, found ${dots}`);
  assert.match(PAGE_HTML, /\.rail :focus-visible \{ outline-color:var\(--rail-focus\); \}/);
});

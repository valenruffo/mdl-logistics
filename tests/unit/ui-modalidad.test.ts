/**
 * The Modalidad segmented control, rendered by the real `CLIENT_JS` against a
 * tiny fake DOM (the same technique `ui-rail.test.ts` uses for the rail).
 *
 * The assertions are about what the operator actually gets on screen:
 *
 * - the control is the first field, a radio pair (domicilio / sucursal), no
 *   native dialog involved;
 * - switching it re-derives the visible field set: domicilio shows the address
 *   group, sucursal shows Sucursal + postal code and hides the address group;
 * - shared values (postal code, recipient, package) carry over an edit;
 * - nothing is invented on a switch: the sucursal field stays empty and each
 *   modality keeps its own declared-value policy (domicilio optional empty,
 *   sucursal prefilled with the project's 100000 and editable).
 *
 * Everything is offline and fictional (R11): the fetch is stubbed, no server,
 * no browser.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeMessage } from '../../src/ui/actions';
import { CLIENT_JS } from '../../src/ui/server';
import { HAPPY_MESSAGE, SUCURSAL_MESSAGE } from './fixtures';

// ------------------------------------------------------------- the fake DOM

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
  name = '';

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
    if (name === 'id') (this as unknown as { id: string }).id = value;
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
    // The rail's state blocks look for their dot; the form harness needs none.
    if (selector !== '.b') return null;
    let dot = this.children.find((child) => (child.className ?? '').split(' ').includes('b'));
    if (dot === undefined) {
      dot = new FakeNode('span');
      dot.className = 'b';
      this.children.push(dot);
    }
    return dot;
  }

  querySelectorAll(selector: string): FakeNode[] {
    if (selector !== '[data-key]') return [];
    const found: FakeNode[] = [];
    const walk = (node: FakeNode): void => {
      for (const child of node.children) {
        if (child.attrs.has('data-key')) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children = [];
  }
}

interface Form {
  /** Every descendant carrying a data-key, keyed by it. */
  byKey(): Map<string, FakeNode>;
  /** The group headings the form currently shows, in order. */
  groups(): string[];
  text(key: string): string;
  setValue(key: string, value: string): void;
  fireModalidad(next: 'domicilio' | 'sucursal'): void;
}

async function renderForm(message: string): Promise<Form> {
  const registry = new Map<string, FakeNode>();
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
    location: { assign: () => undefined },
  };

  const fetchStub = async (url: string, options?: { body?: string }) => {
    if (url === '/api/analyze') {
      const body = JSON.parse(options?.body ?? '{}') as { message: string };
      return { ok: true, status: 200, json: async () => analyzeMessage(body.message) };
    }
    // GET /api/console: a minimal, empty snapshot for the rail.
    return {
      ok: true,
      status: 200,
      json: async () => ({
        session: { lastCheck: null, expiry: null },
        runs: { rows: [] },
        errors: { latest: null },
        warnings: [],
        readAt: '2026-01-01T00:00:00.000Z',
      }),
    };
  };

  const run = new Function('document', 'fetch', 'localStorage', 'matchMedia', CLIENT_JS);
  run(fakeDocument, fetchStub, { getItem: () => null, setItem: () => undefined }, undefined);

  node('message').value = message;
  node('analyze').fire('click');
  // The analyze round trip is one promise chain: give the microtasks a turn.
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 5));

  const grid = registry.get('shipment-form');
  assert.ok(grid, 'the form rendered into #shipment-form');

  const descendants = (): FakeNode[] => {
    const found: FakeNode[] = [];
    const walk = (node: FakeNode): void => {
      for (const child of node.children) {
        found.push(child);
        walk(child);
      }
    };
    walk(grid);
    return found;
  };

  const radioOf = (modality: string): FakeNode => {
    const radio = descendants().find(
      (candidate) => candidate.type === 'radio' && candidate.value === modality,
    );
    assert.ok(radio, `the form carries a ${modality} radio`);
    return radio;
  };

  return {
    byKey: () => {
      const map = new Map<string, FakeNode>();
      for (const candidate of descendants()) {
        const key = candidate.getAttribute('data-key');
        if (key !== null && (candidate.type !== 'radio' || candidate.checked)) map.set(key, candidate);
      }
      return map;
    },
    groups: () =>
      descendants()
        .filter((candidate) => candidate.className === 'group')
        .map((candidate) => candidate.textContent),
    text: (key) => mapOf(grid).get(key)?.value ?? '',
    setValue: (key, value) => {
      const field = mapOf(grid).get(key);
      assert.ok(field, `the form carries an editable ${key}`);
      field.value = value;
    },
    fireModalidad: (next) => radioOf(next).fire('change'),
  };

  function mapOf(gridNode: FakeNode): Map<string, FakeNode> {
    const map = new Map<string, FakeNode>();
    const walk = (node: FakeNode): void => {
      for (const child of node.children) {
        const key = child.getAttribute('data-key');
        if (key !== null && (child.type !== 'radio' || child.checked)) map.set(key, child);
        walk(child);
      }
    };
    walk(gridNode);
    return map;
  }
}

// ------------------------------------------------------------------- the form

test('the Modalidad control renders first as a radio pair, prefilled from the parse', async () => {
  const form = await renderForm(SUCURSAL_MESSAGE);

  assert.deepEqual(form.groups(), [
    'Modalidad de envío',
    'Destino',
    'Destinatario',
    'Paquete · valores por defecto',
    'Monto declarado (opcional)',
  ]);

  const byKey = form.byKey();
  assert.equal(byKey.get('modalidad')?.value, 'sucursal', 'the parse prefilled the segmented control');
  assert.equal(byKey.get('zipCode')?.value, '1419');
  assert.equal(byKey.get('sucursal')?.value, 'Sucursal Villa Ejemplo - Av. Falsa 123');
  assert.equal(byKey.get('declaredValue')?.value, '100000', 'the declared value is prefilled, visible and editable');
  assert.equal(byKey.get('province'), undefined, 'the address group is hidden in sucursal mode');
});

test('switching Modalidad re-derives the visible field set in place', async () => {
  const form = await renderForm(HAPPY_MESSAGE);

  assert.equal(form.byKey().get('modalidad')?.value, 'domicilio');
  assert.ok(form.byKey().get('province'), 'domicilio shows the address group');
  assert.equal(form.byKey().get('declaredValue')?.value, '', 'domicilio keeps its optional empty declared value');

  form.fireModalidad('sucursal');

  const after = form.byKey();
  assert.equal(after.get('modalidad')?.value, 'sucursal');
  assert.equal(after.get('province'), undefined, 'the address group is gone');
  assert.equal(after.get('sucursal')?.value, '', 'nothing is invented: the operator fills the sucursal field');
  assert.equal(after.get('declaredValue')?.value, '100000', 'sucursal prefills the project declared value');
  assert.equal(after.get('zipCode')?.value, '1901', 'shared values carry over');
  assert.equal(after.get('name')?.value, 'Juan', 'shared values carry over');

  // And back: the domicilio set is restored, address group included.
  form.fireModalidad('domicilio');
  assert.ok(form.byKey().get('province'));
  assert.equal(form.byKey().get('declaredValue')?.value, '', 'back to the domicilio policy');
});

test('an operator edit to a shared field survives the switch', async () => {
  const form = await renderForm(HAPPY_MESSAGE);

  form.setValue('zipCode', '1424');
  form.fireModalidad('sucursal');

  assert.equal(form.byKey().get('zipCode')?.value, '1424', 'the edited postal code is not silently reset');
});

/**
 * A fake Playwright surface for the Envío Nube sucursal journey (R11: fictional
 * data, recorded page structure, never the live panel).
 *
 * It implements exactly the subset of the Playwright API the page object uses on
 * the two sucursal screens (`#/agency-shipment`, `#/agency-shipment/quotation`)
 * and on the shipment detail page (`/shipping-details/<id>`):
 *
 * - locators over a tiny element tree (CSS subset + the handful of XPath probes
 *   the page object actually runs);
 * - the copy matchers used by the page object arrive as regular expressions, so
 *   the harness tests them against `copyPattern` output unchanged;
 * - the screen-to-screen navigation the panel's own buttons trigger, with the
 *   observed routes;
 * - the panel's own validity gates (`Continuar` enabling on screen P, the create
 *   button enabling on screen Q).
 *
 * Every click is recorded, so a test can prove that `Crear envío` was never
 * clicked. Nothing here opens a browser, touches a network or reads a secret.
 */
import type { Frame, Locator, Page } from 'playwright';
import { formatArsMask } from '../../src/executor/currency';
import { ENVIO_NUBE_FRAME_HOST } from '../../src/executor/panel';

const FRAME_ORIGIN = `https://${ENVIO_NUBE_FRAME_HOST}`;
const ADMIN_ORIGIN = 'https://tienda-ejemplo.mitiendanube.com';

/** Stand-in for the real panel's UUID option values. */
export interface HarnessOption {
  value: string;
  text: string;
}

export interface HarnessOptions {
  /** Sucursal dropdown options; defaults to the observed CP 1419 list (plan §4c). */
  branches?: HarnessOption[];
  /** Freight radio cards; defaults to one active approved card plus inactive noise. */
  carriers?: { text: string; group: 'activas' | 'inactivas' }[];
  /** Detail-page shipment id heading, e.g. `#EM1053`. */
  shipmentId?: string;
  /** Unit labels per screen-P measure field; override to simulate the unit trap. */
  units?: { height?: string; width?: string; depth?: string; weight?: string; declaredValue?: string };
  /**
   * Models a declared-value mask whose controlled state refuses typed input
   * (the value never changes): used to prove the executor stops loudly on a
   * masked readback that disagrees with the approved amount.
   */
  declaredValueFrozen?: boolean;
  /**
   * The frame route the fake session starts on — what a previous run left open.
   * Defaults to the agency screen; `/create-single-shipment` models the observed
   * live failure, where the frame was stranded on the domicilio screen.
   */
  initialPath?: string;
  /**
   * Hash routes the fake SPA refuses to re-route, modeling the observed live
   * failure: a same-document goto changed the admin hash but never dispatched
   * the app router, so the frame stayed on the previous screen.
   */
  ignoredHashRoutes?: readonly string[];
}

export interface SucursalHarness {
  page: Page;
  /** Every clicked button/label text, in order — the "never clicked" evidence. */
  clicks: readonly string[];
  /** Every screen path the fake page was navigated to, in order — the entry evidence. */
  navigations: readonly string[];
  /** Current frame path (`/agency-shipment`, `/agency-shipment/quotation`, …). */
  framePath(): string;
  /** Values of every named input/select on the current screen. */
  inputValues(): Record<string, string>;
  selectedBranchValue(): string;
  checkedFreightLabel(): string | null;
  /** How many times the create button was actually clicked. */
  createClickCount(): number;
}

// ------------------------------------------------------------------ element tree

type Attrs = Record<string, string>;

class El {
  readonly tag: string;
  readonly attrs: Attrs;
  readonly children: El[] = [];
  parent: El | null = null;
  text: string;
  value = '';
  checked = false;
  disabled = false;
  visible = true;
  /** Panel-side validity gate; `null` means "enabled like any other control". */
  enabledWhen: (() => boolean) | null = null;
  onClick: (() => void) | null = null;
  /**
   * The declared-value input is currency-masked (Argentine format): every digit
   * the mask sees — typed or written programmatically — is a **cent**, and the
   * display is reformatted after each write (`"100000"` → `$ 1.000,00`). This is
   * the observed live failure mode of a raw programmatic write.
   */
  currencyMask = false;
  /** A frozen mask refuses typed input: the value never changes. */
  maskFrozen = false;
  /** The mask's internal digit accumulator (only meaningful when currencyMask). */
  maskDigits = '';

  constructor(tag: string, attrs: Attrs = {}, text = '') {
    this.tag = tag;
    this.attrs = attrs;
    this.text = text;
  }

  append(...nodes: El[]): this {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
    return this;
  }
}

function textOf(el: El): string {
  const own = el.text;
  const nested = el.children.map(textOf).filter((part) => part !== '');
  return [own, ...nested].filter((part) => part !== '').join(' ').replace(/\s+/g, ' ').trim();
}

function isLeaf(el: El): boolean {
  return el.children.every((child) => child.tag === 'input' || child.tag === 'select' || child.tag === 'option');
}

function descendants(el: El): El[] {
  const out: El[] = [];
  const walk = (node: El): void => {
    for (const child of node.children) {
      out.push(child);
      walk(child);
    }
  };
  walk(el);
  return out;
}

// ------------------------------------------------------------------ selectors

interface Step {
  tag: string | null;
  attr: string | null;
  attrValue: string | null;
}

function parseStep(step: string): Step {
  const match = /^([a-zA-Z][\w-]*)?(?:\[([^\]=]+)(?:="([^"]*)")?\])?$/.exec(step);
  if (match === null) throw new Error(`harness: unsupported selector step: ${step}`);
  return { tag: match[1] ?? null, attr: match[2] ?? null, attrValue: match[3] ?? null };
}

function stepMatches(el: El, step: Step): boolean {
  if (step.tag !== null && el.tag !== step.tag) return false;
  if (step.attr !== null) {
    if (!(step.attr in el.attrs)) return false;
    if (step.attrValue !== null && el.attrs[step.attr] !== step.attrValue) return false;
  }
  return step.tag !== null || step.attr !== null;
}

function cssMatch(el: El, selector: string): boolean {
  const steps = selector.trim().split(/\s+/).map(parseStep);
  const matchesFrom = (node: El, index: number): boolean => {
    if (!stepMatches(node, steps[index])) return false;
    if (index === 0) return true;
    for (let parent = node.parent; parent !== null; parent = parent.parent) {
      if (matchesFrom(parent, index - 1)) return true;
    }
    return false;
  };
  return matchesFrom(el, steps.length - 1);
}

/**
 * The XPath shapes the page object actually runs. `preceding` and `ancestor`
 * axes are reverse document order, so `[1]` is the nearest candidate.
 */
function evalXpath(base: El, raw: string, doc: El): El[] {
  const expr = raw.replace(/^xpath=/, '');
  const match = /^(ancestor|preceding)::(.+)$/.exec(expr);
  if (match === null) throw new Error(`harness: unsupported xpath expression: ${raw}`);
  const axis = match[1] as 'ancestor' | 'preceding';
  const rest = match[2];

  let candidates: El[];
  if (axis === 'ancestor') {
    candidates = [];
    for (let parent = base.parent; parent !== null; parent = parent.parent) candidates.push(parent);
  } else {
    const order = new Map<El, number>();
    descendants(doc).forEach((el, index) => order.set(el, index));
    const baseOrder = order.get(base);
    if (baseOrder === undefined) throw new Error('harness: element is not in the document');
    const ancestors = new Set<El>();
    for (let parent = base.parent; parent !== null; parent = parent.parent) ancestors.add(parent);
    candidates = descendants(doc)
      .filter((el) => (order.get(el) as number) < baseOrder && !ancestors.has(el))
      .reverse();
  }

  const selfList = /^\*\[(self::[\w-]+(?: or self::[\w-]+| or @role="heading")*)\](?:\[(\d+)\])?$/.exec(rest);
  if (selfList !== null) {
    const tags = selfList[1].split(' or ');
    const filtered = candidates.filter((el) =>
      tags.some((tag) => (tag.startsWith('@role') ? el.attrs['role'] === 'heading' : el.tag === tag.replace('self::', ''))),
    );
    const picked = filtered[(selfList[2] ? Number(selfList[2]) : 1) - 1];
    return picked === undefined ? [] : [picked];
  }

  const countButtons = /^\*\[count\(\.\/\/button\) = 1\]\[(\d+)\]\/button$/.exec(rest);
  if (countButtons !== null) {
    const filtered = candidates.filter((el) => descendants(el).filter((d) => d.tag === 'button').length === 1);
    const picked = filtered[Number(countButtons[1]) - 1];
    return picked === undefined ? [] : picked.children.filter((child) => child.tag === 'button');
  }

  const descendantButtons = /^([\w-]+)\[(\d+)\]\/\/button\[(\d+)\]$/.exec(rest);
  if (descendantButtons !== null) {
    const filtered = candidates.filter((el) => el.tag === descendantButtons[1]);
    const picked = filtered[Number(descendantButtons[2]) - 1];
    const buttons = picked === undefined ? [] : descendants(picked).filter((d) => d.tag === 'button');
    const button = buttons[Number(descendantButtons[3]) - 1];
    return button === undefined ? [] : [button];
  }

  const simple = /^([\w-]+)(?:\[(\d+)\])?$/.exec(rest);
  if (simple !== null) {
    const filtered = candidates.filter((el) => el.tag === simple[1]);
    const picked = filtered[(simple[2] ? Number(simple[2]) : 1) - 1];
    return picked === undefined ? [] : [picked];
  }

  throw new Error(`harness: unsupported xpath expression: ${raw}`);
}

// ------------------------------------------------------------------ locators

class FakeLocator {
  constructor(
    private readonly harness: Harness,
    private readonly match: (el: El) => boolean,
    private readonly pick: number | null = null,
  ) {}

  private all(): El[] {
    const doc = this.harness.body();
    const candidates = [doc, ...descendants(doc)];
    const matched = candidates.filter((el) => this.match(el));
    return this.pick === null ? matched : matched.slice(this.pick, this.pick + 1);
  }

  private one(): El {
    const found = this.all();
    if (found.length === 0) throw new Error('harness: locator resolved to no element');
    return found[0];
  }

  first(): Locator {
    return new FakeLocator(this.harness, this.match, 0) as unknown as Locator;
  }

  nth(index: number): Locator {
    return new FakeLocator(this.harness, this.match, index) as unknown as Locator;
  }

  async count(): Promise<number> {
    return this.all().length;
  }

  async waitFor(options: { state?: string }): Promise<void> {
    const found = this.all();
    if (found.length === 0 || !(found[0].visible ?? true)) {
      throw new Error(`harness: locator.waitFor timed out (state: ${options.state ?? 'visible'})`);
    }
  }

  async isVisible(): Promise<boolean> {
    const found = this.all();
    return found.length > 0 && found[0].visible;
  }

  async isEnabled(): Promise<boolean> {
    const found = this.all();
    if (found.length === 0) throw new Error('harness: isEnabled resolved to no element');
    const el = found[0];
    if (el.disabled) return false;
    return el.enabledWhen === null ? true : el.enabledWhen();
  }

  async isDisabled(): Promise<boolean> {
    const found = this.all();
    if (found.length === 0) return false;
    return found[0].disabled || (found[0].enabledWhen !== null && !found[0].enabledWhen());
  }

  async isChecked(): Promise<boolean> {
    const found = this.all();
    return found.length > 0 && found[0].checked;
  }

  async inputValue(): Promise<string> {
    return this.one().value;
  }

  async fill(value: string): Promise<void> {
    const el = this.one();
    if (el.currencyMask) {
      // A programmatic write is what the real mask reinterprets (the observed
      // live failure): the raw digits land as a cent amount — `fill("100000")`
      // renders `$ 1.000,00`, not the approved 100000.
      el.maskDigits = value.replace(/\D/g, '');
      el.value = el.maskDigits === '' ? '' : formatArsMask(Number(el.maskDigits) / 100);
      return;
    }
    el.value = value;
  }

  async pressSequentially(value: string): Promise<void> {
    const el = this.one();
    if (!el.currencyMask) {
      el.value = el.value + value;
      return;
    }
    if (el.maskFrozen) return;
    // Real key events: every typed digit accumulates into the mask's cent
    // amount and the display is reformatted — typing `"100000,00"` lands on
    // `$ 100.000,00` (100000 ARS), while the bare `"100000"` lands on
    // `$ 1.000,00` (1000 ARS), the observed live failure.
    for (const char of value) {
      if (/\d/.test(char)) el.maskDigits += char;
    }
    el.value = el.maskDigits === '' ? '' : formatArsMask(Number(el.maskDigits) / 100);
  }

  async press(key?: string): Promise<void> {
    const el = this.one();
    if (el.currencyMask && key === 'Backspace') {
      // The executor only ever clears the masked field with select-all +
      // Backspace (never a programmatic fill), so model exactly that: the
      // digit accumulator empties and the display follows.
      el.maskDigits = '';
      el.value = '';
      return;
    }
    // Any other key (the blur/Tab, the select-all) is a no-op: the fake panel
    // keeps every value it holds.
  }

  async click(options: { trial?: boolean } = {}): Promise<void> {
    const el = this.one();
    if (!el.visible) throw new Error('harness: element is not visible');
    if (options.trial === true) return;
    if (el.disabled || (el.enabledWhen !== null && !el.enabledWhen())) {
      throw new Error('harness: element is disabled');
    }
    el.onClick?.();
    // Clicking a wrapping label checks its radio, as the real panel does.
    if (el.tag === 'label') {
      const radio = descendants(el).find((d) => d.attrs['type'] === 'radio' || d.attrs['type'] === 'checkbox');
      if (radio !== undefined) this.harness.checkRadio(radio);
    }
    const name = textOf(el);
    if (name !== '') this.harness.clicks.push(name);
  }

  async check(): Promise<void> {
    const el = this.one();
    if (el.attrs['type'] === 'radio' || el.attrs['type'] === 'checkbox') this.harness.checkRadio(el);
    else el.onClick?.();
  }

  async innerText(): Promise<string> {
    return textOf(this.one());
  }

  async textContent(): Promise<string> {
    return textOf(this.one());
  }

  async getAttribute(name: string): Promise<string | null> {
    const found = this.all();
    return found.length === 0 ? null : (found[0].attrs[name] ?? null);
  }

  async allInnerTexts(): Promise<string[]> {
    return this.all().map(textOf);
  }

  async selectOption(options: { value: string }): Promise<void> {
    const el = this.one();
    const option = el.children.find((child) => child.attrs['value'] === options.value);
    if (option === undefined) {
      throw new Error(`harness: no option with value ${JSON.stringify(options.value)}`);
    }
    el.value = options.value;
  }

  locator(selector: string): Locator {
    if (selector.startsWith('xpath=') || /^(ancestor|preceding)::/.test(selector)) {
      const base = this.one();
      const results = new Set(evalXpath(base, selector, this.harness.body()));
      return new FakeLocator(this.harness, (el) => results.has(el)) as unknown as Locator;
    }
    return new FakeLocator(this.harness, (el) => cssMatch(el, selector)) as unknown as Locator;
  }

  getByRole(role: string, options: { name?: string | RegExp } = {}): Locator {
    const roleMatch = (el: El): boolean => {
      if (role === 'heading') return /^h[1-6]$/.test(el.tag) || el.attrs['role'] === 'heading';
      if (role === 'button') return el.tag === 'button' || el.attrs['role'] === 'button';
      return el.attrs['role'] === role;
    };
    const nameMatch = (el: El): boolean => {
      if (options.name === undefined) return true;
      const text = textOf(el);
      return options.name instanceof RegExp ? options.name.test(text) : text.includes(options.name);
    };
    return new FakeLocator(this.harness, (el) => roleMatch(el) && nameMatch(el)) as unknown as Locator;
  }

  getByText(pattern: string | RegExp, _options: { exact?: boolean } = {}): Locator {
    return new FakeLocator(this.harness, (el) => {
      if (!isLeaf(el)) return false;
      const text = textOf(el);
      return pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern);
    }) as unknown as Locator;
  }
}

// ------------------------------------------------------------------ harness

/** Path of the admin document that hosts the Envío Nube app. */
const ADMIN_APP_PATH = '/admin/apps/envionube/ar';

/** Frame route the app SPA mounts when the admin hash is `#/dashboard`. */
const DASHBOARD_FRAME_ROUTE = '/dashboard';

class Harness {
  readonly clicks: string[] = [];
  private readonly navigations: string[] = [];
  private readonly screens = new Map<string, El>();
  /** Hash routes the SPA ignores, modeling the observed live panel failure. */
  private readonly ignoredHashRoutes: ReadonlySet<string>;
  private currentPath = '';
  private createClicked = 0;

  constructor(ignoredHashRoutes: readonly string[] = []) {
    this.ignoredHashRoutes = new Set(ignoredHashRoutes);
  }

  addScreen(path: string, body: El): void {
    this.screens.set(path, body);
  }

  hasScreen(path: string): boolean {
    return this.screens.has(path);
  }

  navigate(path: string): void {
    if (!this.screens.has(path)) throw new Error(`harness: no screen built for ${path}`);
    this.currentPath = path;
  }

  /**
   * A UI action (a click, not a `goto`) that routes the SPA to `path`. Recorded
   * in `navigations` like any other route change, so the entry evidence stays
   * complete however the walk mounted the screen.
   */
  navigateViaUi(path: string): void {
    this.navigations.push(path);
    this.navigate(path);
  }

  /**
   * Resolves the screen a `goto` targets, modeling the hash-routed SPA inside
   * the admin app (the observed live behavior that stranded the frame):
   *
   * - a goto whose document path differs from the admin app is a fresh mount;
   * - a goto to the same frame path is a same-document navigation that needs to
   *   change nothing, so it is fine (a previous run left `#/agency-shipment` open);
   * - a goto that changes only the hash re-routes the SPA **only** when the walk
   *   hops via the dashboard: mounting `#/dashboard` (the app's home route), or
   *   leaving `/dashboard` (from there the hash change dispatches the router —
   *   exactly how the operator's manual walk worked);
   * - any other hash-only goto is a no-op: the hash changes, the frame stays —
   *   the observed live failure this harness exists to reproduce.
   */
  gotoFromUrl(url: string): void {
    const hashIndex = url.indexOf('#');
    const beforeHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
    const targetPath = hashIndex >= 0 ? url.slice(hashIndex + 1).split('?')[0] : new URL(url).pathname;

    let documentPath: string | null = null;
    try {
      documentPath = new URL(beforeHash).pathname;
    } catch {
      documentPath = null;
    }
    if (documentPath !== ADMIN_APP_PATH || hashIndex < 0) {
      // A different document (or a direct frame URL): a full mount at the target.
      this.navigations.push(targetPath);
      this.navigate(targetPath);
      return;
    }

    if (targetPath === this.currentPath) return;
    const hopsViaDashboard = targetPath === DASHBOARD_FRAME_ROUTE || this.currentPath === DASHBOARD_FRAME_ROUTE;
    if (hopsViaDashboard && !this.ignoredHashRoutes.has(targetPath)) {
      this.navigations.push(targetPath);
      this.navigate(targetPath);
    }
    // otherwise: no-op — the hash changed, the frame did not re-route.
  }

  body(): El {
    const body = this.screens.get(this.currentPath);
    if (body === undefined) throw new Error(`harness: no screen built for ${this.currentPath}`);
    return body;
  }

  recordCreateClick(): void {
    this.createClicked += 1;
  }

  checkRadio(radio: El): void {
    const group = radio.attrs['name'];
    if (group !== undefined) {
      for (const other of descendants(this.body())) {
        if (other !== radio && other.attrs['name'] === group) other.checked = false;
      }
    }
    radio.checked = true;
  }

  state() {
    return {
      framePath: (): string => this.currentPath,
      clicks: this.clicks as readonly string[],
      navigations: this.navigations as readonly string[],
      inputValues: (): Record<string, string> => {
        // Merged across every screen: the walk ends on screen Q, but the screen-P
        // fills are part of the same run and the same fake panel.
        const values: Record<string, string> = {};
        for (const body of this.screens.values()) {
          for (const el of descendants(body)) {
            const name = el.attrs['name'];
            if (name !== undefined && (el.tag === 'input' || el.tag === 'select')) values[name] = el.value;
          }
        }
        return values;
      },
      selectedBranchValue: (): string => {
        const select = descendants(this.body()).find((el) => el.attrs['name'] === 'sucursal');
        return select?.value ?? '';
      },
      checkedFreightLabel: (): string | null => {
        const radio = descendants(this.body()).find((el) => el.attrs['name'] === 'freight-option' && el.checked);
        if (radio === undefined || radio.parent === null) return null;
        return textOf(radio.parent);
      },
      createClickCount: (): number => this.createClicked,
    };
  }
}

class FakeFrame {
  constructor(private readonly harness: Harness) {}

  url(): string {
    return FRAME_ORIGIN + this.harness.state().framePath();
  }

  locator(selector: string): Locator {
    return new FakeLocator(this.harness, (el) => cssMatch(el, selector)) as unknown as Locator;
  }

  getByRole(role: string, options: { name?: string | RegExp } = {}): Locator {
    return new FakeLocator(this.harness, () => true).getByRole(role, options);
  }

  getByText(pattern: string | RegExp, options: { exact?: boolean } = {}): Locator {
    return new FakeLocator(this.harness, () => true).getByText(pattern, options);
  }
}

class FakePage {
  constructor(private readonly harness: Harness, private readonly frame: FakeFrame) {}

  url(): string {
    return `${ADMIN_ORIGIN}${ADMIN_APP_PATH}#${this.harness.state().framePath()}`;
  }

  /** Same shape as `Page.goto`; the options are accepted and ignored. */
  async goto(url: string, _options?: { waitUntil?: string; timeout?: number }): Promise<void> {
    this.harness.gotoFromUrl(url);
  }

  frames(): Frame[] {
    return [this.frame as unknown as Frame];
  }

  context(): { pages: () => Page[] } {
    return { pages: () => [this as unknown as Page] };
  }
}

// ------------------------------------------------------------------ screens

function fieldDiv(label: string, name: string, value: string): El {
  const div = new El('div', { class: 'field' });
  div.append(new El('label', {}, label));
  div.append(new El('input', { name }, '', value));
  return div;
}

function measureDiv(
  label: string,
  name: string,
  value: string,
  unit: string,
  mask: { currency: boolean; frozen?: boolean } | null = null,
): El {
  const div = new El('div', { class: 'field' });
  div.append(new El('label', {}, label));
  const input = new El('input', { name }, '', value);
  if (mask !== null && mask.currency) {
    input.currencyMask = true;
    input.maskFrozen = mask.frozen === true;
  }
  div.append(input);
  div.append(new El('button', {}, unit));
  return div;
}

const DEFAULT_BRANCHES: HarnessOption[] = [
  { value: 'uuid-villa-devoto', text: 'Villa Devoto (Av Beiro) - Av. Francisco Beiró, 4740, C.A.B.A., Buenos Aires' },
  { value: 'uuid-hop-1', text: 'Punto Andreani Hop - Av. San Martín 5001, C.A.B.A., Buenos Aires' },
  { value: 'uuid-hop-2', text: 'Punto Andreani Hop - Av. Triunvirato 4300, C.A.B.A., Buenos Aires' },
];

const DEFAULT_CARRIERS = [
  { text: 'Andreani a sucursal', group: 'activas' as const },
  { text: 'Correo Argentino a sucursal', group: 'inactivas' as const },
];

function buildScreenP(harness: Harness, options: HarnessOptions): El {
  const body = new El('body');
  const units = { height: 'cm', width: 'cm', depth: 'cm', weight: 'g', declaredValue: '$', ...options.units };
  body.append(
    new El('h1', {}, 'Envío manual a sucursal'),
    fieldDiv('Nombre', 'customer.name', ''),
    fieldDiv('Apellido', 'customer.surname', ''),
    fieldDiv('Email (opcional)', 'customer.email', ''),
    fieldDiv('Teléfono (opcional)', 'customer.phoneNumber', ''),
    measureDiv('Alto', 'box.height', '', units.height),
    measureDiv('Ancho', 'box.width', '', units.width),
    measureDiv('Profundidad', 'box.depth', '', units.depth),
    measureDiv('Peso', 'box.weight', '', units.weight),
    // The real panel renders `Valor declarado` as a currency mask; the fake
    // models it so the tests reproduce the live failure of a raw write.
    measureDiv('Valor declarado', 'declaredValue', '', units.declaredValue, {
      currency: true,
      frozen: options.declaredValueFrozen === true,
    }),
  );

  const required = ['customer.name', 'customer.surname', 'box.height', 'box.width', 'box.depth', 'box.weight', 'declaredValue'];
  const submit = new El('div', { role: 'submit-form' }, 'Continuar');
  submit.enabledWhen = () => {
    const values = harness.state().inputValues();
    return required.every((name) => (values[name] ?? '').trim() !== '');
  };
  submit.onClick = () => harness.navigate('/agency-shipment/quotation');
  body.append(submit);
  return body;
}

function buildScreenQ(harness: Harness, options: HarnessOptions): El {
  const body = new El('body');
  body.append(new El('h2', {}, 'Destino'));
  body.append(fieldDiv('Código postal', 'address.zipCode', ''));

  body.append(new El('h2', {}, 'Modalidad de envío'));
  const carriers = options.carriers ?? DEFAULT_CARRIERS;
  for (const group of ['activas', 'inactivas'] as const) {
    body.append(new El('h3', {}, group === 'activas' ? 'Modalidades activas' : 'Modalidades inactivas'));
    for (const carrier of carriers.filter((candidate) => candidate.group === group)) {
      const label = new El('label', {});
      label.append(new El('input', { type: 'radio', name: 'freight-option' }));
      if (group === 'inactivas') {
        label.append(new El('span', {}, `${carrier.text} · Activar modalidad en el checkout de tu tienda`));
      } else {
        label.append(new El('span', {}, carrier.text));
      }
      body.append(label);
    }
  }

  body.append(new El('h2', {}, 'Sucursales'));
  const select = new El('select', { name: 'sucursal', id: 'sucursal' });
  select.append(new El('option', { value: '' }, 'Seleccioná una sucursal'));
  for (const branch of options.branches ?? DEFAULT_BRANCHES) {
    select.append(new El('option', { value: branch.value }, branch.text));
  }
  body.append(select);

  body.append(new El('button', {}, 'Editar'));
  body.append(new El('button', {}, 'Cancelar'));

  const create = new El('button', {}, 'Crear envío');
  create.enabledWhen = () => {
    const state = harness.state();
    return (
      (state.inputValues()['address.zipCode'] ?? '').trim() !== '' &&
      state.checkedFreightLabel() !== null &&
      state.selectedBranchValue() !== ''
    );
  };
  create.onClick = () => {
    harness.recordCreateClick();
    const shipmentId = (options.shipmentId ?? '#EM1053').replace('#', '');
    harness.navigate(`/shipping-details/${shipmentId}`);
  };
  body.append(create);

  const summaryPanel = new El('div', { class: 'summary' });
  summaryPanel.append(new El('h3', {}, 'Resumen del envío'));
  body.append(summaryPanel);
  return body;
}

/**
 * The Envío Nube dashboard (`#/dashboard`), the first hop of the two-hop entry.
 * Carries the verified `Agregar envío manual` anchor and its dropdown option
 * `A sucursal` — the real UI path of the fallback entry (plan §4c).
 */
function buildDashboard(harness: Harness): El {
  const body = new El('body');
  body.append(new El('h1', {}, 'Envío Nube'));
  const addManual = new El('button', {}, 'Agregar envío manual');
  const agencyOption = new El('button', {}, 'A sucursal');
  agencyOption.visible = false;
  agencyOption.onClick = () => harness.navigateViaUi('/agency-shipment');
  addManual.onClick = () => {
    agencyOption.visible = true;
  };
  body.append(addManual, agencyOption);
  return body;
}

/**
 * Stand-in for whatever screen a previous run left open. The default mirrors
 * the observed live failure: the frame stranded on the domicilio screen, whose
 * visible headings were "Envío manual a domicilio | Calcular costo de envío".
 */
function buildPreviousScreen(): El {
  const body = new El('body');
  body.append(new El('h1', {}, 'Envío manual a domicilio'), new El('h2', {}, 'Calcular costo de envío'));
  return body;
}

function buildDetail(options: HarnessOptions): El {
  const body = new El('body');
  body.append(new El('h1', {}, options.shipmentId ?? '#EM1053'));
  body.append(new El('div', { class: 'badge' }, 'Por enviar'));
  body.append(new El('div', { class: 'badge' }, 'Envío manual'));
  body.append(new El('div', {}, 'Envío creado con éxito'));

  const buyCard = new El('div', { class: 'card' });
  buyCard.append(new El('h2', {}, 'Comprar etiqueta'));
  buyCard.append(new El('p', {}, 'El código de seguimiento se generará automáticamente al imprimir la etiqueta'));
  body.append(buyCard);

  const dataCard = new El('div', { class: 'card' });
  dataCard.append(new El('h2', {}, 'Datos del envío'));
  dataCard.append(new El('p', {}, 'Modalidad: Andreani a sucursal · Costo: $4.500'));
  body.append(dataCard);

  const infoCard = new El('div', { class: 'card' });
  infoCard.append(new El('h2', {}, 'Más información'));
  infoCard.append(new El('p', {}, 'Datos del destinatario, Datos del cliente'));
  body.append(infoCard);

  body.append(new El('button', {}, 'Comprar'));
  return body;
}

/** Builds the harness with the dashboard, the two sucursal screens and the detail page pre-registered. */
export function buildSucursalHarness(options: HarnessOptions = {}): SucursalHarness {
  const harness = new Harness(options.ignoredHashRoutes ?? []);
  harness.addScreen('/dashboard', buildDashboard(harness));
  harness.addScreen('/agency-shipment', buildScreenP(harness, options));
  harness.addScreen('/agency-shipment/quotation', buildScreenQ(harness, options));
  const shipmentId = (options.shipmentId ?? '#EM1053').replace('#', '');
  harness.addScreen(`/shipping-details/${shipmentId}`, buildDetail(options));

  const initialPath = options.initialPath ?? '/agency-shipment';
  if (!harness.hasScreen(initialPath)) harness.addScreen(initialPath, buildPreviousScreen());
  harness.navigate(initialPath);

  const frame = new FakeFrame(harness);
  const page = new FakePage(harness, frame);

  return {
    page: page as unknown as Page,
    get clicks(): readonly string[] {
      return harness.state().clicks;
    },
    get navigations(): readonly string[] {
      return harness.state().navigations;
    },
    framePath: harness.state().framePath,
    inputValues: harness.state().inputValues,
    selectedBranchValue: harness.state().selectedBranchValue,
    checkedFreightLabel: harness.state().checkedFreightLabel,
    createClickCount: harness.state().createClickCount,
  };
}

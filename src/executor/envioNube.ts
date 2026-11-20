import type { Frame, Locator, Page } from 'playwright';
import { CARRIER_NAME } from '../core/carrier';
import type { PackageDefaults } from '../core/config';
import { sameText, normalizeText, textContains } from '../core/normalize';
import type { ShipmentRequest, SucursalShipmentRequest } from '../core/types';
import {
  branchIdentity,
  parseStreetNumberPair,
  textContainsStreetNumberPair,
  textContainsStreetTokens,
  type StreetNumberPair,
} from './branch';
import {
  hashSucursalApprovalPayload,
  type SucursalApprovalPayload,
} from './approval';
import { hashApprovalPayload, type ApprovalPayload } from './approval';
import { copyPattern } from './copy';
import { arsAmountsEqual, formatArsTyping, parseArsAmount } from './currency';
import { ExecutorError, UnknownOutcomeError, asPreClickAbort, detailsOf, messageOf } from './errors';
import { readEnvInt } from './env';
import { adminAppDashboardUrl, BOT_CHALLENGE_FRAME_HOST, ENVIO_NUBE_FRAME_HOST, VERIFIED_AGENCY_PANEL_URL } from './panel';
import { gotoAgencyEntry } from './session';
import { poll, sleep } from './wait';

export { ENVIO_NUBE_FRAME_HOST };

/**
 * Page object for the real Envío Nube manual-shipment journey
 * (docs/plans/mvp-01-manual-shipment.md §4c, observed by DOM inspection).
 *
 * Boundaries, in the operator's own words:
 *
 * - **`Crear envío`** (summary, step 4) creates the shipment and does **not**
 *   charge anything. It is clicked by exactly one method, `createShipment`, and
 *   only after the payload read back from the form matches the approved hash.
 *   There is no other call site. A second attempt in the same instance is
 *   refused: an unknown outcome must be reconciled, never retried.
 * - **`Comprar`** (detail page) is the paying action. This class has no method
 *   that clicks it — not even a disabled one. `Comprar` and the `Comprar
 *   etiqueta` card are read with text/visibility reads only, and the unpaid label
 *   is proven **structurally** (`unpaidLabelFailures`), never by matching prose.
 * - Every text comparison goes through `normalizeText`/`sameText`/`textContains`
 *   (`../core/normalize`), and every locator that matches copy goes through
 *   `copyPattern` (`./copy`): case and accents are presentation, not state.
 * - **`Cancelar`** is never clicked: it would silently reset a filled form.
 * - Every fill has a matching read, so the caller can diff what the panel
 *   actually holds against the approved payload.
 * - Every wait is a condition wait (`poll`), never a fixed sleep.
 * - Every failure carries `ExecutorError.details`: frame URL, visible headings,
 *   suspicious bot-challenge text, last action taken.
 */
export const ROUTE_PREFIX = '/create-single-shipment';

export const ROUTES = {
  cost: '/create-single-shipment',
  quotation: '/create-single-shipment/quotation',
  customer: '/create-single-shipment/customer',
} as const;

export const HEADINGS = {
  cost: 'Calcular costo de envío',
  quotation: 'Seleccionar medio de envío',
  customer: 'Completar datos del destinatario',
  summary: 'Resumen del envío',
  agency: 'Envío manual a sucursal',
} as const;

/** `CARRIER_NAME` (S8, `Andreani a domicilio`) lives in `core/carrier.ts`: the
 * gates and the UI need that string and must not load this page object for it. */

export const CONTINUE_BUTTON = 'Continuar';
export const CANCEL_BUTTON = 'Cancelar';

/** Summary step 4. Creates the shipment; does not charge. Gated (see class doc). */
export const CREATE_BUTTON = 'Crear envío';

/** The paying action on the detail page. Visibility assertions only. */
export const COMPRAR_BUTTON = 'Comprar';

/** Card that holds the unpaid label, with the tracking code promised on print. */
export const COMPRAR_CARD = 'Comprar etiqueta';

/**
 * The badge an unpaid shipment carries. Together with the `#EM<number>` heading
 * and the `Comprar` button it is the whole proof that the label was not bought.
 */
export const UNPAID_STATUS_BADGE = 'Por enviar';

export const SUMMARY_STEP_BADGE = 'Paso 4 de 4';

export const SUMMARY_CARDS: readonly string[] = [
  'Datos para envío',
  'Modalidad de envío',
  'Datos del destinatario',
];

/** Detail-page cards observed on the operator's screenshot. */
export const DETAIL_CARDS: readonly string[] = ['Comprar etiqueta', 'Datos del envío', 'Más información'];

/** Detail-page status badges observed on the operator's screenshot. */
export const DETAIL_STATUS_BADGES: readonly string[] = [UNPAID_STATUS_BADGE, 'Envío manual'];

/** The shipment id shown as a heading on the detail page, e.g. `#EM1053`. */
export const SHIPMENT_ID_PATTERN = /#EM\d+/i;

const COST_FIELDS = {
  zipCode: 'zipCode',
  height: 'box.height',
  width: 'box.width',
  depth: 'box.depth',
  weight: 'box.weight',
  declaredValue: 'declaredValue',
} as const;

const RECIPIENT_FIELDS = {
  city: 'address.city',
  address: 'address.address',
  number: 'address.number',
  complement: 'address.complement',
  neighborhood: 'address.neighborhood',
  name: 'customer.name',
  lastName: 'customer.lastName',
} as const;

const PROVINCE_FIELD = 'address.province';
const DELIVERY_OPTION_FIELD = 'deliveryOptionId';

// ------------------------------------------------------- sucursal: verified anchors

/**
 * The two sucursal routes, observed live (`docs/plans/mvp-01-manual-shipment.md`,
 * "Sucursal — Screen P/Q"). Unlike domicilio, the sucursal journey is two screens:
 *
 * - Screen P (`#/agency-shipment`): recipient **and** package on one screen, with
 *   no address section at all — the destination is only a postal code, entered on
 *   the next screen. The declared value is **required** here (domicilio: optional).
 * - Screen Q (`#/agency-shipment/quotation`): postal code, carrier, branch and
 *   the `Crear envío` button on one screen — there is no summary screen.
 *
 * The traps the observation settled, which a domicilio-shaped executor would
 * walk straight into: the surname anchor is `customer.surname` (domicilio uses
 * `customer.lastName`), the postal code lives on screen Q as `address.zipCode`
 * (domicilio screen 1 uses `zipCode`), and the carrier radios are named
 * `freight-option` with `Andreani a sucursal` as the only approved card.
 */
export const AGENCY_ROUTES = {
  recipient: '/agency-shipment',
  quotation: '/agency-shipment/quotation',
} as const;

/** The carrier card approved for sucursal (S8), matched by accessible name. */
export const SUCURSAL_CARRIER_NAME = 'Andreani a sucursal';

/**
 * The section heading screen Q renders only after the postal-code quote
 * resolves. The `freight-option` radios and the `sucursal` dropdown exist only
 * under it, so the walk waits for this heading before reading either.
 */
export const SUCURSAL_QUOTATION_HEADING = 'Modalidad de envío';

const AGENCY_RECIPIENT_FIELDS = {
  name: 'customer.name',
  surname: 'customer.surname',
  email: 'customer.email',
  phoneNumber: 'customer.phoneNumber',
} as const;

const AGENCY_PACKAGE_FIELDS = {
  height: 'box.height',
  width: 'box.width',
  depth: 'box.depth',
  weight: 'box.weight',
  declaredValue: 'declaredValue',
} as const;

const AGENCY_ZIP_FIELD = 'address.zipCode';
const FREIGHT_OPTION_FIELD = 'freight-option';
const SUCURSAL_SELECT_FIELD = 'sucursal';

/** Route prefix of the shipment detail page, asserted after a sucursal create. */
export const SHIPMENT_DETAIL_ROUTE = '/shipping-details/';

/**
 * The verified dashboard anchor of the fallback sucursal entry (observed live:
 * text on the dashboard frame). Used only when the two-hop goto entry failed.
 */
export const DASHBOARD_ADD_MANUAL_BUTTON = 'Agregar envío manual';

/** The exact option text that opens the sucursal journey from that dropdown. */
export const AGENCY_DROPDOWN_OPTION = 'A sucursal';

/**
 * Bounded waits. A stuck screen must abort with evidence, not sit for minutes.
 * Route/heading waits are capped at 25 s, the "Continuar became enabled" gate at
 * 20 s, and the post-creation detail page at 45 s. All are env-overridable.
 */
const DEFAULT_TIMEOUT_MS = readEnvInt('MDL_WAIT_TIMEOUT_MS', 25_000);
const DEFAULT_READY_TIMEOUT_MS = readEnvInt('MDL_READY_TIMEOUT_MS', 20_000);
const DEFAULT_DETAIL_TIMEOUT_MS = readEnvInt('MDL_DETAIL_TIMEOUT_MS', 45_000);

/** Unit controls shown next to each screen-1 input. `null` means "not readable". */
export interface PanelUnits {
  height: string | null;
  width: string | null;
  depth: string | null;
  weight: string | null;
  declaredValue: string | null;
}

export interface CostInput {
  zipCode: string;
  box: PackageDefaults;
}

/** What screen 1 actually holds after filling. */
export interface CostReadback {
  url: string;
  units: PanelUnits;
  zipCode: string;
  height: string;
  width: string;
  depth: string;
  weight: string;
  declaredValue: string;
  continueEnabled: boolean;
}

/** What screen 2 actually holds after selecting the carrier. */
export interface CarrierOptionDiagnostic {
  /** Position among the `deliveryOptionId` radios, as read from the panel. */
  index: number;
  /** Accessible name: `aria-label` when present, otherwise the wrapping label's text. */
  accessibleName: string;
  labelText: string;
  /** Which of the two rendered groups (`Modalidades activas` / `inactivas`) holds it. */
  group: 'activas' | 'inactivas' | 'unknown';
  disabled: boolean;
  checked: boolean;
  visible: boolean;
}

export interface CarrierReadback {
  url: string;
  /** The approved carrier name (`Andreani a domicilio`) — never a panel decoration. */
  selectedName: string;
  /** The full accessible name of the card that was selected, for the report. */
  panelName: string;
  checked: boolean;
  offeredOptions: string[];
  diagnostics: CarrierOptionDiagnostic[];
  continueEnabled: boolean;
}

export interface EnvioNubeOptions {
  timeoutMs?: number;
  readyTimeoutMs?: number;
  detailTimeoutMs?: number;
}

export interface ProvinceOptionReadback {
  value: string;
  text: string;
}

export interface RecipientInput {
  address: ShipmentRequest['address'];
  customer: ShipmentRequest['customer'];
}

/** What screen 3 actually holds after filling. */
export interface RecipientReadback {
  url: string;
  province: { value: string; text: string };
  city: string;
  address: string;
  number: string;
  complement: string;
  neighborhood: string;
  name: string;
  lastName: string;
  continueEnabled: boolean;
}

export interface CardReadback {
  title: string;
  present: boolean;
  text: string | null;
}

/** What screen P actually holds after filling recipient + package. */
export interface AgencyScreenReadback {
  url: string;
  units: PanelUnits;
  name: string;
  /** The panel's `customer.surname` anchor — the request's `lastName`. */
  surname: string;
  email: string;
  phone: string;
  height: string;
  width: string;
  depth: string;
  weight: string;
  declaredValue: string;
  continueEnabled: boolean;
}

/** One `<option>` of the sucursal dropdown, read from the panel. */
export interface BranchOption {
  index: number;
  /** The option's `value` — a UUID on the real panel, never used for matching. */
  value: string;
  /** The option's visible text: the only thing branch matching may compare. */
  text: string;
}

/**
 * Which matching rule produced the outcome: the street+number pair (primary),
 * or the full-text exact comparison (fallback). Every rejection names it (R12).
 */
export type BranchMatchRule = 'street-number-pair' | 'full-text';

/** The outcome of branch-name matching, as data so it can be tested offline. */
export type BranchMatch =
  | { kind: 'unique'; option: BranchOption; rule: BranchMatchRule }
  | {
      kind: 'none';
      options: readonly BranchOption[];
      nearMatches: readonly BranchOption[];
      rule: BranchMatchRule;
      /** Why nothing was selected, as data; the rejection prints it (R12). */
      reason: 'empty-request' | 'no-option-contains-street' | 'street-without-number' | 'no-exact-text-match';
      /** The pair parsed from the approved name, when one could be. */
      pair: StreetNumberPair | null;
    }
  | {
      kind: 'ambiguous';
      matches: readonly BranchOption[];
      rule: BranchMatchRule;
      reason: 'street-shared-by-multiple-options' | 'multiple-options-equal-after-normalization';
      pair: StreetNumberPair | null;
    };

/** What the sucursal dropdown actually holds after a branch selection. */
export interface BranchReadback {
  url: string;
  /** The approved branch name, as the request wrote it. */
  requestedName: string;
  /** The selected option's `value` (a UUID) — recorded, never used for matching. */
  selectedValue: string;
  /** The selected option's text, as the panel shows it. */
  selectedText: string;
  /** Every option text offered, for the report. */
  offeredOptions: string[];
}

/** What screen Q actually holds, read back after the walk. */
export interface AgencyQuotationReadback {
  url: string;
  zipCode: string;
  /** Accessible name of the checked freight radio, re-read from the panel. */
  checkedCarrierName: string | null;
  branchSelectedValue: string;
  branchSelectedText: string;
  /** Every option text the dropdown offered, for the report. */
  branchOptions: string[];
  /** Visibility assertion only: `createAgencyShipment` is the only click site. */
  createButtonVisible: boolean;
}

/** The approval required to click `Crear envío` on the sucursal quotation screen. */
export interface SucursalCreateApproval {
  /** sha-256 of the sucursal payload the human approved, lower-case hex. */
  approvedHash: string;
  /** The payload read back from the sucursal screens during this run. */
  payload: SucursalApprovalPayload;
}

/** The summary (step 4) — the terminal state of a dry run. */
export interface SummaryReadback {
  url: string;
  heading: string;
  stepBadge: string | null;
  cards: CardReadback[];
  /** Visibility assertion only: nothing in this module clicks it outside `createShipment`. */
  createButtonVisible: boolean;
  bodyText: string;
}

/** The shipment detail page after a gated creation. */
export interface ShipmentDetailReadback {
  url: string;
  /** `#EM<number>`, the shipment's own identifier. */
  shipmentId: string;
  /** Text of the heading that carries the id, exactly as the panel shows it. */
  shipmentIdHeading: string | null;
  /** Known badge names found on the page, matched case- and accent-insensitively. */
  statusBadges: string[];
  /** Badge text exactly as the panel shows it. */
  badgeTexts: string[];
  cards: CardReadback[];
  /**
   * Text of the `Comprar etiqueta` card. Informational only: it goes into the
   * report and is never the proof that the label is unpaid.
   */
  buyCardText: string | null;
  /** Accessible names of every visible button, as read. */
  buttonNames: string[];
  /** Visibility assertion only: `Comprar` is never clicked. */
  buyButtonVisible: boolean;
  bodyText: string;
}

/** Read-only reconciliation after an unknown creation outcome. */
export interface ReconciliationReport {
  dashboardUrl: string;
  frameUrl: string | null;
  searchedFor: { zipCode: string; recipientName: string };
  matches: string[];
  bodyText: string;
  method: string;
  interpretation: string;
}

/** The approval required to click `Crear envío`. */
export interface CreateApproval {
  /** sha-256 of the payload the human approved, lower-case hex. */
  approvedHash: string;
  /** The payload read back from the form during this run. */
  payload: ApprovalPayload;
}

/** Pathname of a frame/page URL, or `''` when the URL is not parseable. */
export function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

/**
 * Cloudflare Turnstile is invisible most of the time; when it escalates, its
 * frame carries visible text. This probe only *reports* suspicion so a timeout
 * failure is diagnosable. It never attempts to solve or dismiss a challenge.
 */
export async function describeBotChallenge(page: Page): Promise<string[]> {
  const details: string[] = [];
  for (const frame of page.frames()) {
    if (!frame.url().includes(BOT_CHALLENGE_FRAME_HOST)) continue;
    const raw = await frame.locator('body').innerText({ timeout: 1_500 }).catch(() => '');
    const text = raw.replace(/\s+/g, ' ').trim();
    if (text !== '') {
      details.push(`SUSPECTED bot challenge: ${frame.url()} shows text: ${text.slice(0, 300)}`);
    }
  }
  if (details.length === 0) {
    details.push(
      'no visible Turnstile text detected (an invisible challenge is still possible and can clear the form without a prompt)',
    );
  }
  return details;
}

export class EnvioNube {
  private readonly page: Page;
  private readonly timeoutMs: number;
  private readonly readyTimeoutMs: number;
  private readonly detailTimeoutMs: number;

  /** Describes the last action, so a timeout failure names what was attempted. */
  private lastAction = 'no action taken yet';

  /** `Crear envío` may be clicked at most once per instance. */
  private createAttempted = false;

  /** Page that owns the shipment detail frame, for evidence screenshots. */
  private detailPage: Page | null = null;

  constructor(page: Page, options: EnvioNubeOptions = {}) {
    this.page = page;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.detailTimeoutMs = options.detailTimeoutMs ?? DEFAULT_DETAIL_TIMEOUT_MS;
  }

  // ---------------------------------------------------------------- framing

  /** The Envío Nube frame, or a loud failure listing every frame present. */
  async requireFrame(): Promise<Frame> {
    const frame = await poll(
      async () => {
        const entry = this.frameEntries()[0];
        return entry === undefined ? null : entry.frame;
      },
      { timeoutMs: this.timeoutMs },
    );
    if (frame !== null) return frame;
    const details = [
      `no frame on the page has a URL containing "${ENVIO_NUBE_FRAME_HOST}"`,
      'the run expects the store admin to be open on Envío Nube → Agregar envío manual',
      ...(await this.describe()),
    ];
    throw new ExecutorError('the Envío Nube iframe was not found', details);
  }

  private frameEntries(): { page: Page; frame: Frame }[] {
    const entries: { page: Page; frame: Frame }[] = [];
    for (const page of this.page.context().pages()) {
      for (const frame of page.frames()) {
        if (frame.url().includes(ENVIO_NUBE_FRAME_HOST)) entries.push({ page, frame });
      }
    }
    return entries;
  }

  private currentFrame(): Frame | undefined {
    const entry = this.frameEntries()[0];
    return entry === undefined ? undefined : entry.frame;
  }

  /** Waits for the panel's own route (`/create-single-shipment/...`). */
  async waitForRoute(route: string): Promise<Frame> {
    const frame = await poll(
      async () => {
        const candidate = this.currentFrame();
        if (candidate === undefined) return null;
        return pathnameOf(candidate.url()).endsWith(route) ? candidate : null;
      },
      { timeoutMs: this.timeoutMs },
    );
    if (frame !== null) return frame;
    const details = await this.describe();
    throw new ExecutorError(`timed out after ${this.timeoutMs}ms waiting for the panel route "${route}"`, details);
  }

  private note(action: string): void {
    this.lastAction = action;
  }

  /** Diagnostic snapshot attached to every failure. */
  private async describe(frame?: Frame): Promise<string[]> {
    const details: string[] = [
      `last action: ${this.lastAction}`,
      `admin page url: ${this.page.url()}`,
    ];
    const target = frame ?? this.currentFrame();
    if (target !== undefined) {
      details.push(`panel frame url: ${target.url()}`);
      const headings = await target.getByRole('heading').allInnerTexts().catch(() => []);
      const compactHeadings = headings
        .map((heading) => heading.replace(/\s+/g, ' ').trim())
        .filter((heading) => heading !== '');
      details.push(`visible headings: ${compactHeadings.length === 0 ? '(none)' : compactHeadings.join(' | ')}`);
      const body = await target.locator('body').innerText({ timeout: 2_000 }).catch(() => '');
      details.push(`panel text (first 600 chars): ${body.replace(/\s+/g, ' ').trim().slice(0, 600)}`);
    } else {
      details.push('no frame matched the Envío Nube host; frames on the page:');
      for (const page of this.page.context().pages()) {
        for (const candidate of page.frames()) {
          details.push(`  - ${candidate.url() === '' ? '(no url yet)' : candidate.url()}`);
        }
      }
    }
    details.push(...(await describeBotChallenge(this.page)));
    return details;
  }

  // ------------------------------------------------------------- primitives

  private async waitForVisible(locator: Locator, label: string, frame: Frame): Promise<void> {
    try {
      await locator.first().waitFor({ state: 'visible', timeout: this.timeoutMs });
    } catch {
      throw new ExecutorError(`timed out after ${this.timeoutMs}ms waiting for ${label}`, await this.describe(frame));
    }
  }

  private async waitForHeading(frame: Frame, heading: string, screen: string): Promise<void> {
    const locator = frame.getByRole('heading', { name: copyPattern(heading) });
    const visible = await poll(
      async () => ((await locator.count()) > 0 ? true : null),
      { timeoutMs: this.timeoutMs },
    );
    if (visible === null) {
      const details = [`expected heading: "${heading}"`, ...(await this.describe(frame))];
      throw new ExecutorError(`timed out after ${this.timeoutMs}ms waiting for ${screen}: heading "${heading}" never appeared`, details);
    }
  }

  private async inputValue(frame: Frame, name: string): Promise<string> {
    const locator = frame.locator(`input[name="${name}"]`).first();
    try {
      return await locator.inputValue({ timeout: 10_000 });
    } catch {
      throw new ExecutorError(`the panel has no readable input [name="${name}"]`, await this.describe(frame));
    }
  }

  private async fillField(frame: Frame, name: string, value: string): Promise<void> {
    const locator = frame.locator(`input[name="${name}"]`).first();
    try {
      await locator.waitFor({ state: 'visible', timeout: this.timeoutMs });
      await locator.fill(value);
      this.note(`filled [name="${name}"]=${JSON.stringify(value)}`);
    } catch (error) {
      throw new ExecutorError(`could not fill [name="${name}"]: ${messageOf(error)}`, await this.describe(frame));
    }
  }

  /**
   * `Continuar`, found by copy first. The observed sucursal screen renders it
   * with a custom `role="submit-form"` instead of a plain button role, so when
   * no button role matches, the verified attribute anchor is tried before the
   * lookup gives up. A missing match on both anchors is the caller's timeout.
   */
  private async continueButton(frame: Frame): Promise<Locator> {
    const byRole = frame.getByRole('button', { name: copyPattern(CONTINUE_BUTTON, { exact: true }) }).first();
    if ((await byRole.count().catch(() => 0)) > 0) return byRole;
    const bySubmitRole = frame.locator('[role="submit-form"]').first();
    if ((await bySubmitRole.count().catch(() => 0)) > 0) {
      this.note('"Continuar" resolved through [role="submit-form"] (observed on the sucursal screen)');
      return bySubmitRole;
    }
    return byRole;
  }

  /**
   * `Continuar` is disabled until the screen is valid. Waiting for it to become
   * enabled is the precondition for advancing: a disabled button is never clicked.
   */
  private async waitForContinueEnabled(
    frame: Frame,
    screen: string,
    timeoutMs: number = this.readyTimeoutMs,
  ): Promise<void> {
    const button = await this.continueButton(frame);
    try {
      await button.waitFor({ state: 'visible', timeout: timeoutMs });
    } catch {
      throw new ExecutorError(`${screen}: the "${CONTINUE_BUTTON}" button never appeared`, await this.describe(frame));
    }
    const enabled = await poll(async () => ((await button.isEnabled()) ? true : null), { timeoutMs });
    if (enabled === null) {
      const details = [
        `"${CONTINUE_BUTTON}" stayed disabled for ${timeoutMs}ms, so the screen never became valid`,
        'bounded: the run aborts with evidence instead of waiting for minutes',
        'a Cloudflare challenge or a reload that cleared the form produces exactly this symptom; the run stops instead of retrying',
        ...(await this.describe(frame)),
      ];
      throw new ExecutorError(`${screen}: "${CONTINUE_BUTTON}" never became enabled`, details);
    }
  }

  private async clickContinue(frame: Frame, screen: string): Promise<void> {
    await this.waitForContinueEnabled(frame, screen);
    try {
      await (await this.continueButton(frame)).click({ timeout: this.timeoutMs });
      this.note(`clicked "${CONTINUE_BUTTON}" on ${screen}`);
    } catch (error) {
      // The iframe can navigate or reload while the click resolves. The route
      // assertion that follows is the real verdict; this note explains a timeout.
      this.note(
        `click on "${CONTINUE_BUTTON}" (${screen}) raised: ${messageOf(error)}; the following route assertion decides whether the panel advanced`,
      );
    }
  }

  /**
   * Copy presence, matched case- and accent-insensitively (`copyPattern`). This
   * replaced a raw string comparison that reported a real, created shipment as
   * "cannot be proven" over the panel's own spelling.
   */
  private async textPresent(frame: Frame, text: string): Promise<boolean> {
    return (await frame.getByText(copyPattern(text), { exact: false }).count().catch(() => 0)) > 0;
  }

  /** Best-effort read of the nearest `div`/`section`/`article`/`li` around a text. */
  private async containerText(frame: Frame, text: string): Promise<string | null> {
    const label = frame.getByText(copyPattern(text), { exact: false }).first();
    const container = label
      .locator('xpath=ancestor::*[self::div or self::section or self::article or self::li][1]')
      .first();
    const hasContainer = (await container.count().catch(() => 0)) > 0;
    const source = hasContainer ? container : label;
    const raw = await source.innerText({ timeout: 3_000 }).catch(() => '');
    const compact = raw
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{2,}/g, '\n')
      .trim();
    return compact === '' ? null : compact.slice(0, 2_000);
  }

  private async bodyText(frame: Frame, limit = 8_000): Promise<string> {
    const raw = await frame.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
    return raw
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, limit);
  }

  /** Screenshot evidence into `artifacts/`. Returns false instead of masking the real failure. */
  async captureEvidence(path: string): Promise<boolean> {
    const target = this.detailPage ?? this.page;
    try {
      await target.screenshot({ path, fullPage: false });
      return true;
    } catch {
      return false;
    }
  }

  // --------------------------------------------------------- screen 1: cost

  /**
   * Unit verification happens **before** any write: the panel shows dimensions in
   * cm and weight in **grams**, so a mismatch (for example weight in kg) would
   * store a magnitude off by 1000. Aborting is the only safe outcome.
   */
  async fillCost(input: CostInput): Promise<void> {
    const frame = await this.waitForRoute(ROUTES.cost);
    await this.waitForHeading(frame, HEADINGS.cost, 'screen 1 (Calcular costo de envío)');

    const units = await this.readUnits(frame);
    const problems: string[] = [];
    const expectUnit = (label: string, actual: string | null, expected: string): void => {
      if (actual !== expected) {
        problems.push(`${label} unit reads ${JSON.stringify(actual)}, expected "${expected}"`);
      }
    };
    expectUnit(COST_FIELDS.height, units.height, 'cm');
    expectUnit(COST_FIELDS.width, units.width, 'cm');
    expectUnit(COST_FIELDS.depth, units.depth, 'cm');
    expectUnit(COST_FIELDS.weight, units.weight, 'g');
    if (problems.length > 0) {
      const details = [
        ...problems,
        `observed units: ${JSON.stringify(units)}`,
        'nothing was filled: writing the declared magnitudes under different units would be wrong',
        ...(await this.describe(frame)),
      ];
      throw new ExecutorError('refusing to fill screen 1: the unit controls do not match the declared magnitudes', details);
    }

    this.note('filling screen 1 (postal code, package, declared value)');
    await this.fillField(frame, COST_FIELDS.zipCode, input.zipCode);
    await this.fillField(frame, COST_FIELDS.height, String(input.box.heightCm));
    await this.fillField(frame, COST_FIELDS.width, String(input.box.widthCm));
    await this.fillField(frame, COST_FIELDS.depth, String(input.box.depthCm));
    await this.fillField(frame, COST_FIELDS.weight, String(input.box.weightG));
    if (input.box.declaredValueArs !== undefined) {
      await this.fillField(frame, COST_FIELDS.declaredValue, String(input.box.declaredValueArs));
    }

    await this.waitForContinueEnabled(frame, 'screen 1 (Calcular costo de envío)');
  }

  /** Reads back every screen-1 field, exactly as the panel holds it. */
  async readCost(): Promise<CostReadback> {
    const frame = await this.waitForRoute(ROUTES.cost);
    return {
      url: frame.url(),
      units: await this.readUnits(frame),
      zipCode: await this.inputValue(frame, COST_FIELDS.zipCode),
      height: await this.inputValue(frame, COST_FIELDS.height),
      width: await this.inputValue(frame, COST_FIELDS.width),
      depth: await this.inputValue(frame, COST_FIELDS.depth),
      weight: await this.inputValue(frame, COST_FIELDS.weight),
      declaredValue: await this.inputValue(frame, COST_FIELDS.declaredValue),
      continueEnabled: await (await this.continueButton(frame)).isEnabled().catch(() => false),
    };
  }

  /** Advances to screen 2, asserting both the route and its heading. */
  async continueFromCost(): Promise<void> {
    const frame = await this.waitForRoute(ROUTES.cost);
    await this.clickContinue(frame, 'screen 1 (Calcular costo de envío)');
    const quotation = await this.waitForRoute(ROUTES.quotation);
    await this.waitForHeading(quotation, HEADINGS.quotation, 'screen 2 (Seleccionar medio de envío)');
  }

  private async readUnits(frame: Frame): Promise<PanelUnits> {
    return {
      height: await this.readUnit(frame, COST_FIELDS.height),
      width: await this.readUnit(frame, COST_FIELDS.width),
      depth: await this.readUnit(frame, COST_FIELDS.depth),
      weight: await this.readUnit(frame, COST_FIELDS.weight),
      declaredValue: await this.readUnit(frame, COST_FIELDS.declaredValue),
    };
  }

  /**
   * The unit is a `<button>` next to the input (`cm`, `g`, `$`). No ids or labels
   * exist on screen 1, so the anchor is "nearest ancestor holding exactly one
   * button". The looser fallback can only produce a *false abort* (the units then
   * disagree with cm/g), never a wrong magnitude written into the panel.
   */
  private async readUnit(frame: Frame, name: string): Promise<string | null> {
    const input = frame.locator(`input[name="${name}"]`).first();
    const strict = input.locator('xpath=ancestor::*[count(.//button) = 1][1]/button').first();
    const strictText = await this.unitText(strict);
    if (strictText !== null) return strictText;
    const loose = input.locator('xpath=ancestor::div[1]//button[1]').first();
    return this.unitText(loose);
  }

  private async unitText(locator: Locator): Promise<string | null> {
    const count = await locator.count().catch(() => 0);
    if (count === 0) return null;
    const raw = await locator.innerText({ timeout: 3_000 }).catch(() => '');
    const text = raw.replace(/\s+/g, ' ').trim();
    return text === '' ? null : text;
  }

  // ---------------------------------------------------- screen 2: carrier

  /**
   * Selects `Andreani a domicilio` from the **`Modalidades activas`** group.
   *
   * Observed facts that shaped this method:
   * - The screen renders two groups: `Modalidades activas` (selectable) and
   *   `Modalidades inactivas` (each card carries `Activar modalidad en el checkout
   *   de tu tienda`). Only the active card is genuinely selectable.
   * - The native radio `input` is visually hidden behind the card, so clicking it
   *   directly never resolves; the person clicks the wrapping label/card.
   * - Radio `id`s embed UUIDs and are never used as selectors.
   * - The accessible name may include the price and delivery estimate, so it is
   *   read from the panel and matched by substring, never assumed.
   * - Success is the screen's own gate: `Continuar` becoming enabled.
   */
  async selectCarrier(name: string = CARRIER_NAME): Promise<CarrierReadback> {
    const frame = await this.waitForRoute(ROUTES.quotation);
    await this.waitForHeading(frame, HEADINGS.quotation, 'screen 2 (Seleccionar medio de envío)');
    return this.selectRadioCarrier(frame, DELIVERY_OPTION_FIELD, name, 'screen 2 (Seleccionar medio de envío)', {
      waitForContinueGate: true,
    });
  }

  /**
   * Selects the sucursal carrier card, `Andreani a sucursal`, on screen Q
   * (`#/agency-shipment/quotation`). Same radio mechanics as domicilio — hidden
   * `input`, wrapping label as the click target, `Modalidades activas` group
   * detection by nearest preceding heading — but with the observed
   * `freight-option` field name, and no `Continuar` gate: screen Q has no
   * `Continuar`, the create button lives there instead.
   */
  async selectCarrierSucursal(name: string = SUCURSAL_CARRIER_NAME): Promise<CarrierReadback> {
    const frame = await this.waitForRoute(AGENCY_ROUTES.quotation);
    return this.selectRadioCarrier(frame, FREIGHT_OPTION_FIELD, name, 'sucursal screen Q (#/agency-shipment/quotation)', {
      waitForContinueGate: false,
    });
  }

  /**
   * The radio mechanics shared by both quotation screens (observed, §4c):
   *
   * - The native radio `input` is visually hidden behind the card, so clicking it
   *   directly never resolves; the person clicks the wrapping label/card.
   * - Radio `id`s embed UUIDs and are never used as selectors.
   * - The accessible name may include the price and delivery estimate, so it is
   *   read from the panel and matched by substring, never assumed.
   * - Only a card inside `Modalidades activas` is genuinely selectable; the group
   *   is resolved from the nearest preceding heading.
   * - Success is either the screen's own `Continuar` gate (domicilio) or the
   *   radio reporting checked (sucursal, whose screen has no `Continuar`).
   */
  private async selectRadioCarrier(
    frame: Frame,
    fieldName: string,
    name: string,
    screen: string,
    options: { waitForContinueGate: boolean },
  ): Promise<CarrierReadback> {
    const diagnostics = await this.readCarrierDiagnostics(frame, fieldName);
    const offeredOptions = diagnostics.map((option) => option.accessibleName);
    const nameMatches = diagnostics.filter(
      (option) => !option.disabled && textContains(option.accessibleName, name),
    );
    // Prefer the card inside `Modalidades activas`. If the group heading could not
    // be resolved but the approved name matches exactly one radio, that radio is
    // unambiguous — and the screen's own gate (`Continuar` enabling) still decides.
    const match = nameMatches.find((option) => option.group === 'activas') ?? (nameMatches.length === 1 ? nameMatches[0] : undefined);

    if (match === undefined) {
      const details = [
        ...formatCarrierDiagnostics(diagnostics, fieldName),
        `radios matching ${JSON.stringify(name)} and not disabled: ${nameMatches.length}`,
        'choosing a different carrier is a different product decision and a wrong purchase (R12)',
        ...(await this.describe(frame)),
      ];
      throw new ExecutorError(`the panel offers no selectable "${name}" in "Modalidades activas"`, details);
    }
    if (match.group !== 'activas') {
      this.note(
        `group heading for radio [${match.index}] could not be read; using the only non-disabled name match ${JSON.stringify(match.accessibleName)} and relying on the screen's own gate`,
      );
    }

    const radio = frame.locator(`input[name="${fieldName}"]`).nth(match.index);
    const label = radio.locator('xpath=ancestor::label[1]').first();
    const labelVisible =
      (await label.count().catch(() => 0)) > 0 && (await label.isVisible().catch(() => false));
    try {
      if (labelVisible) {
        await label.click({ timeout: this.timeoutMs });
        this.note(`clicked the label of the active carrier card "${match.accessibleName}" (index ${match.index})`);
      } else {
        // Same control, same single choice: a forced click is used only when the
        // panel hides the native input without a visible label to click.
        await radio.check({ force: true, timeout: this.timeoutMs });
        this.note(`force-checked the hidden radio "${match.accessibleName}" (index ${match.index})`);
      }
    } catch (error) {
      const after = await this.readCarrierDiagnostics(frame, fieldName).catch(() => diagnostics);
      throw new ExecutorError(`could not select the carrier "${match.accessibleName}": ${messageOf(error)}`, [
        ...formatCarrierDiagnostics(after, fieldName),
        ...(await this.describe(frame)),
      ]);
    }

    const checked = await poll(async () => ((await radio.isChecked()) ? true : null), { timeoutMs: 10_000 });
    if (checked === null) {
      const after = await this.readCarrierDiagnostics(frame, fieldName).catch(() => diagnostics);
      throw new ExecutorError('the carrier card was clicked but its radio does not report as checked', [
        ...formatCarrierDiagnostics(after, fieldName),
        ...(await this.describe(frame)),
      ]);
    }

    // The success condition is the screen's own validity gate — the `Continuar`
    // button where the screen has one (domicilio), the checked radio itself where
    // it does not (sucursal screen Q, whose create button lives beside it).
    if (options.waitForContinueGate) {
      try {
        await this.waitForContinueEnabled(frame, screen);
      } catch (error) {
        const after = await this.readCarrierDiagnostics(frame, fieldName).catch(() => diagnostics);
        throw new ExecutorError(messageOf(error), [...detailsOf(error), ...formatCarrierDiagnostics(after, fieldName)]);
      }
    }

    const finalDiagnostics = await this.readCarrierDiagnostics(frame, fieldName).catch(() => diagnostics);
    return {
      url: frame.url(),
      selectedName: name,
      panelName: match.accessibleName,
      checked: true,
      offeredOptions,
      diagnostics: finalDiagnostics,
      continueEnabled: options.waitForContinueGate
        ? await (await this.continueButton(frame)).isEnabled().catch(() => false)
        : false,
    };
  }

  async continueFromQuotation(): Promise<void> {
    const frame = await this.waitForRoute(ROUTES.quotation);
    await this.clickContinue(frame, 'screen 2 (Seleccionar medio de envío)');
    const customer = await this.waitForRoute(ROUTES.customer);
    await this.waitForHeading(customer, HEADINGS.customer, 'screen 3 (Completar datos del destinatario)');
  }

  /**
   * Reads every `deliveryOptionId` radio with the facts needed to choose safely:
   * accessible name, wrapping label text, which rendered group holds it, whether
   * it is disabled, checked or visible. Logged verbatim on any screen-2 failure.
   */
  private async readCarrierDiagnostics(frame: Frame, fieldName: string): Promise<CarrierOptionDiagnostic[]> {
    const radios = frame.locator(`input[name="${fieldName}"]`);
    const count = await radios.count().catch(() => 0);
    const diagnostics: CarrierOptionDiagnostic[] = [];
    for (let index = 0; index < count; index += 1) {
      const radio = radios.nth(index);
      const label = radio.locator('xpath=ancestor::label[1]').first();
      const labelRaw =
        (await label.count().catch(() => 0)) > 0 ? await label.innerText({ timeout: 3_000 }).catch(() => '') : '';
      const ariaLabel = (await radio.getAttribute('aria-label').catch(() => null)) ?? '';
      diagnostics.push({
        index,
        accessibleName: compactText(ariaLabel) || compactText(labelRaw),
        labelText: compactText(labelRaw),
        group: await this.carrierGroup(radio, labelRaw),
        disabled: await radio.isDisabled().catch(() => false),
        checked: await radio.isChecked().catch(() => false),
        visible: await radio.isVisible().catch(() => false),
      });
    }
    return diagnostics;
  }

  /**
   * `activas` / `inactivas` / `unknown`, from the nearest ancestor that holds
   * exactly one of the two section headings. The card's own `Activar modalidad`
   * line is a fallback anchor for the inactive group.
   */
  /**
   * `activas` / `inactivas` / `unknown`, from the **nearest heading that precedes**
   * the radio in document order (`Modalidades activas` renders first, then
   * `Modalidades inactivas`).
   *
   * Ancestor text matching does not work here: the group container's raw text
   * value does not contain a plain-space `Modalidades activas`, so an ancestor
   * probe classified every radio as `unknown`. The preceding-heading axis is
   * independent of how the cards are nested.
   */
  private async carrierGroup(radio: Locator, labelRaw: string): Promise<'activas' | 'inactivas' | 'unknown'> {
    const probes = [
      'xpath=preceding::*[self::h1 or self::h2 or self::h3 or self::h4 or self::h5 or self::h6 or @role="heading"][1]',
      'xpath=preceding::*[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "modalidades")][1]',
    ];
    for (const probe of probes) {
      const heading = radio.locator(probe).first();
      if ((await heading.count().catch(() => 0)) === 0) continue;
      const text = compactText(await heading.innerText({ timeout: 3_000 }).catch(() => ''));
      if (text === '') continue;
      // `inactivas` contains `activas` as a substring, so it is tested first.
      if (/inactivas/i.test(text)) return 'inactivas';
      if (/activas/i.test(text)) return 'activas';
    }
    if (textContains(labelRaw, 'Activar modalidad')) return 'inactivas';
    return 'unknown';
  }

  // --------------------------------------------------- screen 3: recipient

  /** The select's real option list, read from the panel before any write. */
  async readProvinceOptions(): Promise<ProvinceOptionReadback[]> {
    const frame = await this.waitForRoute(ROUTES.customer);
    return this.provinceOptions(frame);
  }

  private async provinceOptions(frame: Frame): Promise<ProvinceOptionReadback[]> {
    const options = frame.locator(`select[name="${PROVINCE_FIELD}"] option`);
    const count = await options.count().catch(() => 0);
    if (count === 0) {
      throw new ExecutorError('the province <select> has no readable options', await this.describe(frame));
    }
    const result: ProvinceOptionReadback[] = [];
    for (let index = 0; index < count; index += 1) {
      const option = options.nth(index);
      const value = (await option.getAttribute('value')) ?? '';
      const text = ((await option.textContent()) ?? '').trim();
      result.push({ value, text });
    }
    return result;
  }

  private async readProvince(frame: Frame): Promise<{ value: string; text: string }> {
    const select = frame.locator(`select[name="${PROVINCE_FIELD}"]`).first();
    const value = await select.inputValue().catch(() => '');
    const options = await this.provinceOptions(frame);
    const selected = options.find((option) => option.value === value);
    return { value, text: selected?.text ?? '' };
  }

  /**
   * Fills the recipient screen. The province is written by the panel's own letter
   * `value` (`C` = Ciudad Autónoma de Buenos Aires), never by visible text, and is
   * re-read afterwards: the selected option text must equal the approved name, or
   * the run stops before advancing.
   */
  async fillRecipient(input: RecipientInput): Promise<void> {
    const frame = await this.waitForRoute(ROUTES.customer);
    await this.waitForHeading(frame, HEADINGS.customer, 'screen 3 (Completar datos del destinatario)');

    const select = frame.locator(`select[name="${PROVINCE_FIELD}"]`).first();
    await this.waitForVisible(select, `select[name="${PROVINCE_FIELD}"]`, frame);

    const expected = input.address.province;
    const options = await this.provinceOptions(frame);
    const option = options.find((candidate) => candidate.value === expected.code);
    if (option === undefined) {
      const details = [
        `approved province: ${expected.name} (code "${expected.code}")`,
        `offered codes: ${options.map((candidate) => `${candidate.value}=${candidate.text}`).join(', ')}`,
        ...(await this.describe(frame)),
      ];
      throw new ExecutorError(`the province <select> does not offer code "${expected.code}"`, details);
    }
    if (!sameText(option.text, expected.name)) {
      const details = [
        `panel option "${expected.code}": ${JSON.stringify(option.text)}`,
        `approved name: ${JSON.stringify(expected.name)}`,
        'the panel and the approved payload disagree, so no value was written',
        ...(await this.describe(frame)),
      ];
      throw new ExecutorError('the province option text does not match the approved payload', details);
    }

    this.note(`selecting ${PROVINCE_FIELD} value="${expected.code}"`);
    try {
      await select.selectOption({ value: expected.code }, { timeout: this.timeoutMs });
    } catch (error) {
      throw new ExecutorError(`could not select province value "${expected.code}": ${messageOf(error)}`, await this.describe(frame));
    }

    const selected = await this.readProvince(frame);
    if (selected.value !== expected.code || !sameText(selected.text, expected.name)) {
      const details = [
        `read back: value=${JSON.stringify(selected.value)} text=${JSON.stringify(selected.text)}`,
        `approved:  value=${JSON.stringify(expected.code)} text=${JSON.stringify(expected.name)}`,
        ...(await this.describe(frame)),
      ];
      throw new ExecutorError('the province select does not hold the approved option after writing it', details);
    }

    // Changing the province re-renders the form and clears the dependent Ciudad
    // field, so wait for the screen to stop changing before writing anything else.
    await this.waitForRecipientSettle(frame);

    // Order matters: Provincia, then Ciudad, then the rest. A province change
    // re-renders the form and resets the city component to empty, so writing the
    // city afterwards is required.
    const fields: { name: string; value: string }[] = [
      { name: RECIPIENT_FIELDS.city, value: input.address.city },
      { name: RECIPIENT_FIELDS.address, value: input.address.address },
      { name: RECIPIENT_FIELDS.number, value: input.address.number },
      ...(input.address.complement === null
        ? []
        : [{ name: RECIPIENT_FIELDS.complement, value: input.address.complement }]),
      { name: RECIPIENT_FIELDS.neighborhood, value: input.address.neighborhood },
      { name: RECIPIENT_FIELDS.name, value: input.customer.name },
      ...(input.customer.lastName === null
        ? []
        : [{ name: RECIPIENT_FIELDS.lastName, value: input.customer.lastName }]),
    ];

    await this.typeFieldsWithDriftCheck(frame, fields, 'screen 3 (Completar datos del destinatario)', () =>
      this.recipientDiagnostics(frame),
    );

    try {
      await this.waitForContinueEnabled(frame, 'screen 3 (Completar datos del destinatario)');
    } catch (error) {
      throw new ExecutorError(messageOf(error), [
        ...detailsOf(error),
        ...(await this.recipientDiagnostics(frame)),
      ]);
    }
  }

  /**
   * Waits until the recipient form stops changing (two identical reads ~500 ms
   * apart, with a province actually selected). Bounded at ~4 s: if it keeps
   * changing, the form is filled anyway and the drift check that follows decides.
   */
  private async waitForRecipientSettle(frame: Frame): Promise<void> {
    const snapshot = async (): Promise<string> => {
      const province = await this.readProvince(frame).catch(() => ({ value: '', text: '' }));
      const values: string[] = [province.value];
      for (const name of Object.values(RECIPIENT_FIELDS)) {
        values.push(
          await frame
            .locator(`input[name="${name}"]`)
            .first()
            .inputValue({ timeout: 3_000 })
            .catch(() => ''),
        );
      }
      return values.join('\u0001');
    };

    let previous = await snapshot();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await sleep(500);
      const current = await snapshot();
      if (current === previous && current.split('\u0001')[0] !== '') return;
      previous = current;
    }
    this.note('the recipient screen kept changing for ~4s; continuing with the reads it holds');
  }

  /**
   * Types each approved value the way a person does, re-fills anything the panel
   * dropped once, and stops loudly if it still reads differently.
   *
   * Refilling a text input is idempotent and touches no irreversible action: it
   * converges on the approved value the panel dropped, it does not retry a failed
   * step or a navigation. A value that still reads wrong after the refill — or
   * that reads empty after being written — is what a reload or a bot challenge
   * does to a filled form, and that is a stop, never a blind retry.
   */
  private async typeFieldsWithDriftCheck(
    frame: Frame,
    fields: readonly { name: string; value: string }[],
    screen: string,
    diagnostics: () => Promise<string[]>,
  ): Promise<void> {
    for (const field of fields) {
      let readback = await this.typeField(frame, field.name, field.value);
      if (readback.trim() === '' && field.value.trim() !== '') {
        // One typed retry: a controlled input may drop the first write. This is
        // not a retry of a failed step and not a navigation — it touches no
        // irreversible action, and the value written is the approved one.
        this.note(`${field.name} read back empty; one typed retry of ${JSON.stringify(field.value)}`);
        readback = await this.typeField(frame, field.name, field.value);
      }
      if (readback.trim() === '' && field.value.trim() !== '') {
        throw new ExecutorError(`the panel did not keep the value written into [name="${field.name}"]`, [
          `wrote ${JSON.stringify(field.value)} into [name="${field.name}"] twice with click + real key events + blur; the panel holds it as empty`,
          'the form is not submitted with an empty required field; nothing was advanced',
          ...(await diagnostics()),
          ...(await this.describe(frame)),
        ]);
      }
    }

    let drift = await this.readFieldDrift(frame, fields);
    if (drift.length > 0) {
      this.note(`refilling values the panel cleared: ${drift.map((entry) => entry.name).join(', ')}`);
      for (const field of fields) {
        if (drift.some((entry) => entry.name === field.name)) {
          await this.typeField(frame, field.name, field.value);
        }
      }
      drift = await this.readFieldDrift(frame, fields);
    }
    if (drift.length > 0) {
      throw new ExecutorError(`${screen}: the panel did not keep the values that were written`, [
        ...drift.map(
          (entry) =>
            `[name="${entry.name}"] reads ${JSON.stringify(entry.actual)}, expected ${JSON.stringify(entry.expected)}`,
        ),
        ...(await diagnostics()),
        ...(await this.describe(frame)),
      ]);
    }
  }

  private async readFieldDrift(
    frame: Frame,
    fields: readonly { name: string; value: string }[],
  ): Promise<{ name: string; expected: string; actual: string }[]> {
    const drift: { name: string; expected: string; actual: string }[] = [];
    for (const field of fields) {
      const actual = await frame
        .locator(`input[name="${field.name}"]`)
        .first()
        .inputValue({ timeout: 3_000 })
        .catch(() => '<unreadable>');
      if (actual !== field.value) drift.push({ name: field.name, expected: field.value, actual });
    }
    return drift;
  }

  /** Everything the panel holds on screen 3 plus its own hint texts, for a loud stop. */
  private async recipientDiagnostics(frame: Frame): Promise<string[]> {
    const lines: string[] = ['recipient form as the panel holds it:'];
    const province = await this.readProvince(frame).catch(() => ({ value: '<unreadable>', text: '' }));
    lines.push(`  province: value=${JSON.stringify(province.value)} text=${JSON.stringify(province.text)}`);
    for (const name of Object.values(RECIPIENT_FIELDS)) {
      const locator = frame.locator(`input[name="${name}"]`).first();
      const value = await locator.inputValue({ timeout: 3_000 }).catch(() => '<unreadable>');
      const disabled = await locator.isDisabled().catch(() => false);
      lines.push(`  [name="${name}"]=${JSON.stringify(value)}${disabled ? ' (disabled)' : ''}`);
    }
    const hints = await frame
      .getByText(/Ingresá|requerid|obligatori/i)
      .allInnerTexts()
      .catch(() => []);
    const uniqueHints = [...new Set(hints.map((hint) => hint.replace(/\s+/g, ' ').trim()))]
      .filter((hint) => hint !== '')
      .slice(0, 10);
    lines.push(`  panel hints: ${uniqueHints.length === 0 ? '(none)' : uniqueHints.join(' | ')}`);
    return lines;
  }

  /** Reads back every screen-3 field, exactly as the panel holds it. */
  async readRecipient(): Promise<RecipientReadback> {
    const frame = await this.waitForRoute(ROUTES.customer);
    return {
      url: frame.url(),
      province: await this.readProvince(frame),
      city: await this.inputValue(frame, RECIPIENT_FIELDS.city),
      address: await this.inputValue(frame, RECIPIENT_FIELDS.address),
      number: await this.inputValue(frame, RECIPIENT_FIELDS.number),
      complement: await this.inputValue(frame, RECIPIENT_FIELDS.complement),
      neighborhood: await this.inputValue(frame, RECIPIENT_FIELDS.neighborhood),
      name: await this.inputValue(frame, RECIPIENT_FIELDS.name),
      lastName: await this.inputValue(frame, RECIPIENT_FIELDS.lastName),
      continueEnabled: await (await this.continueButton(frame)).isEnabled().catch(() => false),
    };
  }

  /**
   * Types a value the way a person does: click, clear, real key events, blur, then
   * read the value back.
   *
   * `fill()` alone is not trusted on this screen. A controlled input can reject a
   * programmatic value assignment and keep rendering its own state, which looks
   * exactly like "the field is empty while everything else filled". The returned
   * value is what the panel holds after the blur, so the caller decides what an
   * empty read means.
   */
  private async typeField(frame: Frame, name: string, value: string): Promise<string> {
    const locator = frame.locator(`input[name="${name}"]`).first();
    try {
      await locator.waitFor({ state: 'visible', timeout: this.timeoutMs });
      await locator.click({ timeout: this.timeoutMs });
      await locator.fill('');
      await locator.pressSequentially(value, { delay: 20, timeout: this.timeoutMs });
      this.note(`typed [name="${name}"]=${JSON.stringify(value)} with real key events`);
      await locator.press('Tab').catch(() => undefined);
      return await locator.inputValue({ timeout: 3_000 }).catch(() => '');
    } catch (error) {
      if (error instanceof ExecutorError) throw error;
      const details = [...(await this.fieldDiagnostics(frame, name)), ...(await this.describe(frame))];
      throw new ExecutorError(`could not type into [name="${name}"]: ${messageOf(error)}`, details);
    }
  }

  /** DOM state of one field, used when the panel refuses a value. */
  private async fieldDiagnostics(frame: Frame, name: string): Promise<string[]> {
    const locator = frame.locator(`input[name="${name}"]`).first();
    const lines = [`field [name="${name}"] DOM state:`];
    if ((await locator.count().catch(() => 0)) === 0) {
      lines.push('  the input is not in the DOM');
      return lines;
    }
    lines.push(`  value=${JSON.stringify(await locator.inputValue({ timeout: 3_000 }).catch(() => '<unreadable>'))}`);
    lines.push(`  aria-invalid=${JSON.stringify(await locator.getAttribute('aria-invalid').catch(() => null))}`);
    lines.push(
      `  disabled=${await locator.isDisabled().catch(() => false)} visible=${await locator.isVisible().catch(() => false)}`,
    );
    // A trial click runs the actionability checks (visible, stable, receives
    // events) without dispatching anything: that is how "covered" is detected.
    let hitTest = 'clickable: visible, stable and receives pointer events';
    try {
      await locator.click({ trial: true, timeout: 2_000 });
    } catch (error) {
      hitTest = messageOf(error).split('\n')[0] ?? messageOf(error);
    }
    lines.push(`  hit test: ${hitTest}`);
    const container = locator.locator('xpath=ancestor::*[self::div or self::section or self::form][1]').first();
    if ((await container.count().catch(() => 0)) > 0) {
      const text = compactText(await container.innerText({ timeout: 3_000 }).catch(() => ''));
      lines.push(`  container text (sibling error text included)=${JSON.stringify(text.slice(0, 400))}`);
    }
    return lines;
  }

  // -------------------------------- sucursal entry: two-hop navigation + one UI fallback

  /**
   * Enters the sucursal journey by **two-hop navigation** (plan §4c, "Sucursal —
   * Screen Entry"): the session goes to the dashboard entry first and then to
   * the agency hash `#/agency-shipment`, which mounts the app frame at the
   * verified panel URL and shows Screen P.
   *
   * Why two hops: a goto whose only difference is the hash is a same-document
   * navigation. Observed live, the admin url changed to `#/agency-shipment` but
   * the Envío Nube SPA inside the iframe stayed on the previous screen — the
   * app router only re-routes when the walk passes through the dashboard.
   *
   * The entry is proven before anything is filled: the frame must sit on the
   * `/agency-shipment` route **and** show the `Envío manual a sucursal` heading.
   * If the frame is still not on `/agency-shipment` after the two-hop goto, the
   * real UI path is tried **once** — `Agregar envío manual`, then the option
   * whose text is exactly `A sucursal` — and no more: one attempt, no loops.
   * If the frame still has not landed, the run stops with the frame URL that
   * was actually reached, never a silent retry.
   */
  async openAgencyEntry(): Promise<void> {
    await gotoAgencyEntry(this.page);
    let frame: Frame;
    try {
      frame = await this.waitForRoute(AGENCY_ROUTES.recipient);
    } catch {
      this.note(
        'the two-hop entry (#/dashboard → #/agency-shipment) did not land the frame on /agency-shipment; one fallback attempt through the real dashboard UI',
      );
      await this.agencyEntryViaDashboardUi();
      try {
        frame = await this.waitForRoute(AGENCY_ROUTES.recipient);
      } catch {
        const reached = this.currentFrame()?.url() ?? '(no Envío Nube frame on the page)';
        throw new ExecutorError(
          `after the two-hop entry (#/dashboard → #/agency-shipment) and one dashboard-UI fallback, the app frame never reached "${AGENCY_ROUTES.recipient}" within ${this.timeoutMs}ms; the frame URL actually reached: ${reached}`,
          await this.describe(),
        );
      }
    }
    await this.waitForHeading(frame, HEADINGS.agency, 'sucursal screen P (#/agency-shipment)');
    this.note(
      `entered the sucursal journey: the app frame sits on ${VERIFIED_AGENCY_PANEL_URL} (admin hash #/agency-shipment)`,
    );
  }

  /**
   * The single fallback entry, used only when the two-hop goto did not re-route
   * the app frame (observed live). Clicks the real UI path once: the verified
   * `Agregar envío manual` button on the dashboard frame, then the option whose
   * text is exactly `A sucursal`. The caller's route assertion is the verdict;
   * there is no second attempt and no loop.
   */
  private async agencyEntryViaDashboardUi(): Promise<void> {
    const frame = await this.requireFrame();
    const addManual = frame
      .getByRole('button', { name: copyPattern(DASHBOARD_ADD_MANUAL_BUTTON, { exact: true }) })
      .first();
    try {
      await addManual.click({ timeout: this.timeoutMs });
      this.note('clicked "Agregar envío manual" on the Envío Nube frame');
    } catch (error) {
      throw new ExecutorError(
        `the fallback entry could not click "${DASHBOARD_ADD_MANUAL_BUTTON}": ${messageOf(error)}`,
        await this.describe(frame),
      );
    }
    const agencyOption = frame.getByText(copyPattern(AGENCY_DROPDOWN_OPTION, { exact: true })).first();
    try {
      await agencyOption.waitFor({ state: 'visible', timeout: this.timeoutMs });
      await agencyOption.click({ timeout: this.timeoutMs });
      this.note(`clicked the "${AGENCY_DROPDOWN_OPTION}" option`);
    } catch (error) {
      throw new ExecutorError(
        `the fallback entry could not click the "${AGENCY_DROPDOWN_OPTION}" option: ${messageOf(error)}`,
        await this.describe(frame),
      );
    }
  }

  // -------------------------------- sucursal screen P: recipient + package

  /** Everything the panel holds on screen P, for a loud stop. */
  private async agencyScreenDiagnostics(frame: Frame): Promise<string[]> {
    const lines: string[] = ['sucursal screen P form as the panel holds it:'];
    for (const name of Object.values(AGENCY_RECIPIENT_FIELDS)) {
      lines.push(`  [name="${name}"]=${JSON.stringify(await this.inputValueQuiet(frame, name))}`);
    }
    for (const name of Object.values(AGENCY_PACKAGE_FIELDS)) {
      lines.push(`  [name="${name}"]=${JSON.stringify(await this.inputValueQuiet(frame, name))}`);
    }
    return lines;
  }

  private async inputValueQuiet(frame: Frame, name: string): Promise<string> {
    return frame
      .locator(`input[name="${name}"]`)
      .first()
      .inputValue({ timeout: 3_000 })
      .catch(() => '<unreadable>');
  }

  /**
   * Fills the sucursal recipient fields on screen P (`#/agency-shipment`).
   *
   * The request's `lastName` goes into the panel's `customer.surname` anchor —
   * a different anchor from domicilio's `customer.lastName`, which is exactly
   * the kind of trap the observations settle. Optional fields (email, phone)
   * are written only when the request carries them; nothing is invented.
   */
  async fillAgencyRecipient(input: { customer: SucursalShipmentRequest['customer'] }): Promise<void> {
    const frame = await this.waitForRoute(AGENCY_ROUTES.recipient);
    const nameInput = frame.locator(`input[name="${AGENCY_RECIPIENT_FIELDS.name}"]`).first();
    await this.waitForVisible(nameInput, `input[name="${AGENCY_RECIPIENT_FIELDS.name}"]`, frame);

    const fields = [
      { name: AGENCY_RECIPIENT_FIELDS.name, value: input.customer.name },
      ...(input.customer.lastName === null
        ? []
        : [{ name: AGENCY_RECIPIENT_FIELDS.surname, value: input.customer.lastName }]),
      ...(input.customer.email === null
        ? []
        : [{ name: AGENCY_RECIPIENT_FIELDS.email, value: input.customer.email }]),
      ...(input.customer.phone === null
        ? []
        : [{ name: AGENCY_RECIPIENT_FIELDS.phoneNumber, value: input.customer.phone }]),
    ];
    await this.typeFieldsWithDriftCheck(frame, fields, 'sucursal screen P (#/agency-shipment)', () =>
      this.agencyScreenDiagnostics(frame),
    );
    // No `Continuar` wait here: the screen stays invalid until the package fields
    // are filled too, and `fillAgencyPackage` is the one that waits for it.
  }

  /**
   * Fills the sucursal package fields on screen P. The unit buttons (`cm` ×3 +
   * `g`, `$` for the declared value) are verified **before** any write, exactly
   * as on the domicilio cost screen: a mismatch aborts with nothing filled.
   * The declared value is required on this screen, so an absent value is a
   * refusal, never a silent skip.
   */
  async fillAgencyPackage(box: SucursalShipmentRequest['box']): Promise<void> {
    const frame = await this.waitForRoute(AGENCY_ROUTES.recipient);

    const units = await this.readUnits(frame);
    const problems: string[] = [];
    const expectUnit = (label: string, actual: string | null, expected: string): void => {
      if (actual !== expected) {
        problems.push(`${label} unit reads ${JSON.stringify(actual)}, expected "${expected}"`);
      }
    };
    expectUnit(AGENCY_PACKAGE_FIELDS.height, units.height, 'cm');
    expectUnit(AGENCY_PACKAGE_FIELDS.width, units.width, 'cm');
    expectUnit(AGENCY_PACKAGE_FIELDS.depth, units.depth, 'cm');
    expectUnit(AGENCY_PACKAGE_FIELDS.weight, units.weight, 'g');
    expectUnit(AGENCY_PACKAGE_FIELDS.declaredValue, units.declaredValue, '$');
    if (problems.length > 0) {
      const details = [
        ...problems,
        `observed units: ${JSON.stringify(units)}`,
        'nothing was filled: writing the declared magnitudes under different units would be wrong',
        ...(await this.describe(frame)),
      ];
      throw new ExecutorError(
        'refusing to fill sucursal screen P: the unit controls do not match the declared magnitudes',
        details,
      );
    }

    if (box.declaredValueArs === undefined) {
      throw new ExecutorError('refusing to fill sucursal screen P: the declared value is required there', [
        'the panel requires "Valor declarado" on the sucursal screen (on domicilio it is optional)',
        'the declared policy lives in config.sucursal.declaredValueArs and is shown editable in the preview',
        ...(await this.describe(frame)),
      ]);
    }

    const fields = [
      { name: AGENCY_PACKAGE_FIELDS.height, value: String(box.heightCm) },
      { name: AGENCY_PACKAGE_FIELDS.width, value: String(box.widthCm) },
      { name: AGENCY_PACKAGE_FIELDS.depth, value: String(box.depthCm) },
      { name: AGENCY_PACKAGE_FIELDS.weight, value: String(box.weightG) },
    ];
    await this.typeFieldsWithDriftCheck(frame, fields, 'sucursal screen P (#/agency-shipment)', () =>
      this.agencyScreenDiagnostics(frame),
    );
    // The declared value is currency-masked on the panel: it is written digit
    // by digit with real key events and verified numerically — never a raw
    // programmatic write and never a string comparison.
    await this.typeAgencyDeclaredValue(frame, box.declaredValueArs);
    await this.waitForContinueEnabled(frame, 'sucursal screen P (#/agency-shipment)');
  }

  /**
   * Types the declared value into the currency-masked input the way the mask
   * accepts it, and verifies the readback **numerically** against the approved
   * amount.
   *
   * The mask counts every digit it sees as a cent and reformats in the
   * Argentine format (`$ 100.000,00` for 100000 ARS). A raw programmatic write
   * of the bare digits (`fill("100000")`) is reinterpreted as a cent amount and
   * renders `$ 1.000,00` — the observed live failure that left `Continuar`
   * disabled. So this field is written with the same real-key-events technique
   * as the city field: click, clear by keyboard, `pressSequentially` digit by
   * digit, blur — **no `fill()`**, not even to clear.
   *
   * The typed string carries the two decimals (`"100000,00"`), because the
   * bare digits are exactly what the mask swallows. The readback is parsed
   * (`$`/thousand `.` stripped, `,` as the decimal mark) and compared as a
   * number; a disagreement aborts naming both values, with no retry.
   */
  private async typeAgencyDeclaredValue(frame: Frame, amountArs: number): Promise<void> {
    const name = AGENCY_PACKAGE_FIELDS.declaredValue;
    const locator = frame.locator(`input[name="${name}"]`).first();
    try {
      await locator.waitFor({ state: 'visible', timeout: this.timeoutMs });
      await locator.click({ timeout: this.timeoutMs });
      await locator.press('ControlOrMeta+a');
      await locator.press('Backspace');
      const typed = formatArsTyping(amountArs);
      await locator.pressSequentially(typed, { delay: 20, timeout: this.timeoutMs });
      this.note(`typed [name="${name}"]=${JSON.stringify(typed)} digit by digit with real key events`);
      await locator.press('Tab').catch(() => undefined);
      const readback = await locator.inputValue({ timeout: 3_000 }).catch(() => '');
      const parsed = parseArsAmount(readback);
      if (parsed === null || !arsAmountsEqual(parsed, amountArs)) {
        throw new ExecutorError(
          `the declared value does not match the approved amount: approved ${amountArs} ARS, the panel holds ${JSON.stringify(readback)}` +
            (parsed === null ? ' (unreadable as an amount)' : ` (parsed ${parsed} ARS)`),
          [
            `approved declaredValueArs: ${amountArs}`,
            `panel readback of [name="${name}"]: ${JSON.stringify(readback)}`,
            'the run stops here: nothing was advanced and nothing was retried',
            ...(await this.agencyScreenDiagnostics(frame)),
            ...(await this.describe(frame)),
          ],
        );
      }
    } catch (error) {
      if (error instanceof ExecutorError) throw error;
      const details = [...(await this.fieldDiagnostics(frame, name)), ...(await this.describe(frame))];
      throw new ExecutorError(`could not type into [name="${name}"]: ${messageOf(error)}`, details);
    }
  }

  /** Reads back every screen-P field, exactly as the panel holds it. */
  async readAgencyScreen(): Promise<AgencyScreenReadback> {
    const frame = await this.waitForRoute(AGENCY_ROUTES.recipient);
    return {
      url: frame.url(),
      units: await this.readUnits(frame),
      name: await this.inputValue(frame, AGENCY_RECIPIENT_FIELDS.name),
      surname: await this.inputValue(frame, AGENCY_RECIPIENT_FIELDS.surname),
      email: await this.inputValue(frame, AGENCY_RECIPIENT_FIELDS.email),
      phone: await this.inputValue(frame, AGENCY_RECIPIENT_FIELDS.phoneNumber),
      height: await this.inputValue(frame, AGENCY_PACKAGE_FIELDS.height),
      width: await this.inputValue(frame, AGENCY_PACKAGE_FIELDS.width),
      depth: await this.inputValue(frame, AGENCY_PACKAGE_FIELDS.depth),
      weight: await this.inputValue(frame, AGENCY_PACKAGE_FIELDS.weight),
      declaredValue: await this.inputValue(frame, AGENCY_PACKAGE_FIELDS.declaredValue),
      continueEnabled: await (await this.continueButton(frame)).isEnabled().catch(() => false),
    };
  }

  /** Advances to screen Q, asserting the route change. Screen P's own heading
   * (`Envío manual a sucursal`) was already asserted at entry (`openAgencyEntry`). */
  async continueFromAgencyRecipient(): Promise<void> {
    const frame = await this.waitForRoute(AGENCY_ROUTES.recipient);
    await this.clickContinue(frame, 'sucursal screen P (#/agency-shipment)');
    await this.waitForRoute(AGENCY_ROUTES.quotation);
  }

  // -------------------------------- sucursal screen Q: destination, carrier, branch, create

  /** Everything the panel holds on screen Q, for a loud stop. */
  private async agencyQuotationDiagnostics(frame: Frame): Promise<string[]> {
    const lines: string[] = ['sucursal screen Q as the panel holds it:'];
    lines.push(`  [name="${AGENCY_ZIP_FIELD}"]=${JSON.stringify(await this.inputValueQuiet(frame, AGENCY_ZIP_FIELD))}`);
    const diagnostics = await this.readCarrierDiagnostics(frame, FREIGHT_OPTION_FIELD).catch(() => []);
    lines.push(...formatCarrierDiagnostics(diagnostics, FREIGHT_OPTION_FIELD));
    const options = await this.branchOptions(frame).catch(() => []);
    lines.push(`  sucursal dropdown (${options.length} options):`);
    for (const option of options) lines.push(`    - value=${option.value} text=${JSON.stringify(option.text)}`);
    return lines;
  }

  /**
   * Writes the destination postal code on screen Q. The anchor is
   * `address.zipCode` — a different name from domicilio's `zipCode`.
   *
   * After the write, the walk waits for the `Modalidad de envío` heading: the
   * panel quotes asynchronously for the entered postal code, and the carrier
   * radios and the branch select only render once that quote resolves. Observed
   * live, the quotation screen initially showed only `Destino` + `Resumen del
   * envío`, and a carrier lookup that ran immediately timed out on radios that
   * did not exist yet. If the heading is still missing at half the wait budget,
   * one change/blur is dispatched on the postal code (the quote may be gated on
   * that event) and the wait resumes for the other half — no loops, still the
   * standard budget in total. A missing heading past the budget is a loud stop
   * that names the heading and the frame URL.
   */
  async fillAgencyDestination(zipCode: string): Promise<void> {
    const frame = await this.waitForRoute(AGENCY_ROUTES.quotation);
    await this.typeFieldsWithDriftCheck(
      frame,
      [{ name: AGENCY_ZIP_FIELD, value: zipCode }],
      'sucursal screen Q (#/agency-shipment/quotation)',
      () => this.agencyQuotationDiagnostics(frame),
    );
    await this.waitForAgencyCarrierSection(frame);
  }

  /**
   * Waits for the `Modalidad de envío` heading on sucursal screen Q, within the
   * standard wait budget split in two halves around one postal-code change/blur
   * dispatch. The carrier radios and the branch select exist only under that
   * heading, so nothing downstream may read them before it renders.
   */
  private async waitForAgencyCarrierSection(frame: Frame): Promise<void> {
    const heading = (): Locator => frame.getByRole('heading', { name: copyPattern(SUCURSAL_QUOTATION_HEADING) });
    const halfBudgetMs = Math.ceil(this.timeoutMs / 2);
    const first = await poll(async () => ((await heading().count()) > 0 ? true : null), { timeoutMs: halfBudgetMs });
    if (first !== null) return;

    this.note(
      `the "${SUCURSAL_QUOTATION_HEADING}" heading is still missing after ${halfBudgetMs}ms; dispatching one change/blur on [name="${AGENCY_ZIP_FIELD}"] to trigger the postal-code quote`,
    );
    await this.dispatchAgencyZipChange(frame);
    const second = await poll(async () => ((await heading().count()) > 0 ? true : null), { timeoutMs: halfBudgetMs });
    if (second !== null) return;

    throw new ExecutorError(
      `timed out after ${this.timeoutMs}ms waiting for sucursal screen Q: heading "${SUCURSAL_QUOTATION_HEADING}" never appeared (the panel's postal-code quote did not resolve, so the carrier radios and the branch select were never rendered)`,
      [
        `missing heading: "${SUCURSAL_QUOTATION_HEADING}"`,
        `panel frame url: ${frame.url()}`,
        'the freight radios and the sucursal dropdown only exist under that heading; nothing was read, selected or created',
        ...(await this.describe(frame)),
      ],
    );
  }

  /**
   * One change/blur on the postal code, best effort: the quote may be gated on
   * that event rather than on the typed value alone. Neither dispatch is
   * retried and neither failure masks the heading wait that follows — a panel
   * that needs neither simply keeps the walk waiting for the quote to resolve.
   */
  private async dispatchAgencyZipChange(frame: Frame): Promise<void> {
    const zip = frame.locator(`input[name="${AGENCY_ZIP_FIELD}"]`).first();
    await zip.dispatchEvent('change').catch(() => undefined);
    await zip.blur().catch(() => undefined);
    this.note(`dispatched one change/blur on [name="${AGENCY_ZIP_FIELD}"]`);
  }

  /** The sucursal dropdown's real option list, read from the panel before any write. */
  async readSucursalOptions(): Promise<BranchOption[]> {
    const frame = await this.waitForRoute(AGENCY_ROUTES.quotation);
    return this.branchOptions(frame);
  }

  private async branchOptions(frame: Frame): Promise<BranchOption[]> {
    const options = frame.locator(`select[name="${SUCURSAL_SELECT_FIELD}"] option`);
    const count = await options.count().catch(() => 0);
    if (count === 0) {
      throw new ExecutorError('the sucursal <select> has no readable options', await this.describe(frame));
    }
    const result: BranchOption[] = [];
    for (let index = 0; index < count; index += 1) {
      const option = options.nth(index);
      const value = (await option.getAttribute('value').catch(() => null)) ?? '';
      const text = ((await option.textContent().catch(() => '')) ?? '').trim();
      result.push({ index, value, text });
    }
    return result;
  }

  /**
   * Selects a branch by its **street+number identity** (the physical address is
   * the branch; prefixes, city names and schedule text are decoration). Option
   * values are UUIDs on the real panel, so the write uses the value read from
   * the matched option, never a guessed one, and the read-back must agree with
   * the approved name by the same identity.
   */
  async selectBranch(name: string): Promise<BranchReadback> {
    const frame = await this.waitForRoute(AGENCY_ROUTES.quotation);
    const select = frame.locator(`select[name="${SUCURSAL_SELECT_FIELD}"]`).first();
    await this.waitForVisible(select, `select[name="${SUCURSAL_SELECT_FIELD}"]`, frame);

    const options = await this.branchOptions(frame);
    const offered = options.map((option) => option.text);
    const match = matchSucursalBranch(name, options);

    if (match.kind === 'none') {
      const details = [
        `approved branch: ${JSON.stringify(name)}`,
        ...branchMatchFailureDetails(match),
        `the dropdown offers ${options.length} options:`,
        ...offered.map((text) => `  - ${JSON.stringify(text)}`),
        ...(match.nearMatches.length > 0
          ? [
              'near matches (reported, never selected):',
              ...match.nearMatches.map((option) => `  - ${JSON.stringify(option.text)}`),
            ]
          : []),
        'branch matching selects by street+number identity — the physical address is the branch (R12); every non-unique outcome is a rejection, never a near match',
        ...(await this.describe(frame)),
      ];
      throw new ExecutorError(
        `no sucursal option matches the approved branch name (${branchRuleLabel(match.rule)} rule failed)`,
        details,
      );
    }
    if (match.kind === 'ambiguous') {
      const what =
        match.reason === 'street-shared-by-multiple-options'
          ? `the sucursal dropdown matches the approved branch street+number pair more than once (${match.matches.length} options)`
          : `the sucursal dropdown matches the approved branch name more than once (${match.matches.length} options)`;
      throw new ExecutorError(what, [
        `approved branch: ${JSON.stringify(name)}`,
        ...branchMatchFailureDetails(match),
        ...match.matches.map((option) => `  - value=${option.value} text=${JSON.stringify(option.text)}`),
        'selecting between same-street branches would be a guess (R12)',
        ...(await this.describe(frame)),
      ]);
    }

    const option = match.option;
    this.note(
      `selecting sucursal option value="${option.value}" (matched by street+number identity, rule: ${match.rule})`,
    );
    try {
      await select.selectOption({ value: option.value }, { timeout: this.timeoutMs });
    } catch (error) {
      throw new ExecutorError(`could not select the branch option: ${messageOf(error)}`, await this.describe(frame));
    }

    const selectedValue = await select.inputValue().catch(() => '');
    const selected = options.find((candidate) => candidate.value === selectedValue);
    const selectedText = selected?.text ?? '';
    // The panel may echo the branch in its own decorated spelling (`Sucursal -
    // …, Ciudad`); the readback agrees with the approved name by street+number
    // identity, the same comparison the approval hash and the diff use.
    if (selectedValue !== option.value || branchIdentity(selectedText) !== branchIdentity(name)) {
      throw new ExecutorError('the sucursal dropdown does not hold the approved branch after writing it', [
        `read back: value=${JSON.stringify(selectedValue)} text=${JSON.stringify(selectedText)}`,
        `approved (by street+number identity): ${JSON.stringify(name)} → ${JSON.stringify(branchIdentity(name))}`,
        ...(await this.describe(frame)),
      ]);
    }

    return {
      url: frame.url(),
      requestedName: name,
      selectedValue,
      selectedText,
      offeredOptions: offered,
    };
  }

  /** Reads back every screen-Q field, exactly as the panel holds it. */
  async readAgencyQuotation(): Promise<AgencyQuotationReadback> {
    const frame = await this.waitForRoute(AGENCY_ROUTES.quotation);
    const diagnostics = await this.readCarrierDiagnostics(frame, FREIGHT_OPTION_FIELD);
    const checked = diagnostics.find((option) => option.checked);
    const options = await this.branchOptions(frame);
    const selectedValue = await frame
      .locator(`select[name="${SUCURSAL_SELECT_FIELD}"]`)
      .first()
      .inputValue()
      .catch(() => '');
    const selected = options.find((option) => option.value === selectedValue);
    return {
      url: frame.url(),
      zipCode: await this.inputValue(frame, AGENCY_ZIP_FIELD),
      checkedCarrierName: checked?.accessibleName ?? null,
      branchSelectedValue: selectedValue,
      branchSelectedText: selected?.text ?? '',
      branchOptions: options.map((option) => option.text),
      createButtonVisible: await frame
        .getByRole('button', { name: copyPattern(CREATE_BUTTON, { exact: true }) })
        .first()
        .isVisible()
        .catch(() => false),
    };
  }

  /**
   * The **only** call site of a sucursal `Crear envío` click.
   *
   * Screen Q has no summary screen: destination, carrier, branch and the create
   * button live together, so the gates run here, in order, and every one of
   * them aborts before clicking:
   * 1. `createAgencyShipment` has not been called before in this instance
   *    (the flag is shared with the domicilio `createShipment`);
   * 2. the payload read back from the sucursal screens hashes to the approved hash.
   *
   * After the click: the shipment detail page is awaited; if it never appears the
   * outcome is genuinely unknown and an `UnknownOutcomeError` is raised. It is
   * never retried and the button is never clicked again.
   */
  async createAgencyShipment(approval: SucursalCreateApproval): Promise<ShipmentDetailReadback> {
    // The gates below run before the click, and `createAttempted` is set
    // immediately before the click, so any error caught with the flag still
    // false happened pre-click (R10): nothing was clicked, therefore nothing
    // was created, and the abort is classified as such instead of leaving an
    // unresolved record. After the flag is set, today's contract holds.
    const wasClicked = this.createAttempted;
    try {
      if (this.createAttempted) {
        throw new ExecutorError(
          'refusing to click "Crear envío" a second time in one run: reconcile the first attempt against the shipments list instead',
        );
      }

      const frame = await this.waitForRoute(AGENCY_ROUTES.quotation);

      const formHash = hashSucursalApprovalPayload(approval.payload);
      const approvedHash = approval.approvedHash.trim().toLowerCase();
      if (approvedHash === '' || formHash !== approvedHash) {
        const details = [
          `approved hash: ${approvedHash === '' ? '(empty)' : approvedHash}`,
          `form hash:     ${formHash}`,
          'the panel no longer holds the approved payload, so nothing was clicked',
        ];
        throw new ExecutorError('refusing to create the shipment: the form does not match the approved payload hash', details);
      }

      const button = frame.getByRole('button', { name: copyPattern(CREATE_BUTTON, { exact: true }) }).first();
      if (!(await button.isVisible().catch(() => false))) {
        throw new ExecutorError(`the "${CREATE_BUTTON}" button is not visible; nothing was clicked`, await this.describe(frame));
      }

      this.createAttempted = true;
      this.note(`clicking "${CREATE_BUTTON}" once on the sucursal quotation screen (approved hash ${approvedHash.slice(0, 12)}…)`);
      let clickError: string | null = null;
      try {
        await button.click({ timeout: this.timeoutMs });
      } catch (error) {
        clickError = messageOf(error);
      }

      const detailFrame = await this.waitForDetailFrame(clickError);
      const path = pathnameOf(detailFrame.url());
      if (!path.startsWith(SHIPMENT_DETAIL_ROUTE)) {
        throw new UnknownOutcomeError(
          `after clicking "${CREATE_BUTTON}" a "#EM<number>" heading appeared outside the shipping-details route (frame path "${path}")`,
          await this.describe(detailFrame),
        );
      }
      const detail = await this.detailFrom(detailFrame);
      const unpaidProblem = labelUnpaidProblem(detail);
      if (unpaidProblem !== null) {
        throw new ExecutorError(unpaidProblem.message, [
          ...unpaidProblem.details,
          ...(await this.describe(detailFrame)),
        ]);
      }
      return detail;
    } catch (error) {
      if (wasClicked || this.createAttempted) throw error;
      throw asPreClickAbort('create gates (sucursal screen Q)', error);
    }
  }

  // ------------------------------------------------- screen 4: the summary

  /**
   * Advances from screen 3 to the summary. The summary URL was never captured, so
   * the screen is located by its heading; the URL assertion is limited to "still
   * inside the `/create-single-shipment` journey".
   */
  async openSummary(): Promise<void> {
    const frame = await this.waitForRoute(ROUTES.customer);
    await this.clickContinue(frame, 'screen 3 (Completar datos del destinatario)');
    const summaryFrame = await this.waitForSummaryHeading('screen 4 (Resumen del envío)');
    const path = pathnameOf(summaryFrame.url());
    if (!path.startsWith(ROUTE_PREFIX)) {
      throw new ExecutorError(`the summary screen appeared outside the shipment journey (frame path "${path}")`, await this.describe(summaryFrame));
    }
  }

  private async waitForSummaryHeading(screen: string): Promise<Frame> {
    const frame = await poll(
      async () => {
        const candidate = this.currentFrame();
        if (candidate === undefined) return null;
        const heading = candidate.getByRole('heading', { name: copyPattern(HEADINGS.summary) });
        return (await heading.count()) > 0 ? candidate : null;
      },
      { timeoutMs: this.timeoutMs },
    );
    if (frame !== null) return frame;
    const details = [`expected heading: "${HEADINGS.summary}"`, ...(await this.describe())];
    throw new ExecutorError(`timed out after ${this.timeoutMs}ms waiting for ${screen}: heading "${HEADINGS.summary}" never appeared`, details);
  }

  /**
   * The terminal state of the dry run: heading, `Paso 4 de 4`, the three cards,
   * and the `Crear envío` button merely *present*. Nothing is clicked.
   */
  async assertSummaryVisible(): Promise<void> {
    const frame = await this.waitForSummaryHeading('screen 4 (Resumen del envío)');

    const badge = await this.readStepBadge(frame);
    if (!sameText(badge ?? '', SUMMARY_STEP_BADGE)) {
      const details = [
        `read badge: ${JSON.stringify(badge)}`,
        `expected badge: "${SUMMARY_STEP_BADGE}" (compared case- and accent-insensitively)`,
        ...(await this.describe(frame)),
      ];
      throw new ExecutorError(`the summary badge reads ${JSON.stringify(badge)}, expected "${SUMMARY_STEP_BADGE}"`, details);
    }

    for (const title of SUMMARY_CARDS) {
      if (!(await this.textPresent(frame, title))) {
        const details = [`missing card: "${title}"`, ...(await this.describe(frame))];
        throw new ExecutorError(`the summary is missing the "${title}" card`, details);
      }
    }

    const createButton = frame.getByRole('button', { name: copyPattern(CREATE_BUTTON, { exact: true }) }).first();
    if (!(await createButton.isVisible().catch(() => false))) {
      const details = [`expected button: "${CREATE_BUTTON}"`, ...(await this.describe(frame))];
      throw new ExecutorError(`the summary does not show the "${CREATE_BUTTON}" button`, details);
    }
  }

  /** Everything the summary actually shows, for the caller's diff and report. */
  async readSummary(): Promise<SummaryReadback> {
    const frame = await this.waitForSummaryHeading('screen 4 (Resumen del envío)');
    const headingLocator = frame.getByRole('heading', { name: copyPattern(HEADINGS.summary) }).first();
    const headingRaw = await headingLocator.innerText({ timeout: 5_000 }).catch(() => '');
    const cards: CardReadback[] = [];
    for (const title of SUMMARY_CARDS) {
      const present = await this.textPresent(frame, title);
      cards.push({ title, present, text: present ? await this.containerText(frame, title) : null });
    }
    return {
      url: frame.url(),
      heading: headingRaw.replace(/\s+/g, ' ').trim(),
      stepBadge: await this.readStepBadge(frame),
      cards,
      createButtonVisible: await frame
        .getByRole('button', { name: copyPattern(CREATE_BUTTON, { exact: true }) })
        .first()
        .isVisible()
        .catch(() => false),
      bodyText: await this.bodyText(frame),
    };
  }

  private async readStepBadge(frame: Frame): Promise<string | null> {
    const locator = frame.getByText(/\bPaso\s+\d+\s+de\s+\d+\b/).first();
    if ((await locator.count().catch(() => 0)) === 0) return null;
    const raw = await locator.innerText({ timeout: 3_000 }).catch(() => '');
    const match = /Paso\s+\d+\s+de\s+\d+/.exec(raw.replace(/\s+/g, ' '));
    return match === null ? null : match[0];
  }

  // ----------------------------------------------- step 4: gated creation

  /**
   * The **only** call site of a `Crear envío` click.
   *
   * Gates, in order, and every one of them aborts before clicking:
   * 1. `createShipment` has not been called before in this instance;
   * 2. the summary screen is present and complete (heading, badge, cards);
   * 3. the payload read back from the form hashes to the approved hash;
   * 4. the summary still names the approved recipient.
   *
   * After the click: the shipment detail page is awaited; if it never appears the
   * outcome is genuinely unknown and an `UnknownOutcomeError` is raised. It is never
   * retried and the button is never clicked again.
   */
  async createShipment(approval: CreateApproval): Promise<ShipmentDetailReadback> {
    // Same classification as `createAgencyShipment`: everything before the
    // click is pre-click, so its failures cannot have created a shipment (R10).
    const wasClicked = this.createAttempted;
    try {
      if (this.createAttempted) {
        throw new ExecutorError(
          'refusing to click "Crear envío" a second time in one run: reconcile the first attempt against the shipments list instead',
        );
      }

      await this.assertSummaryVisible();
      const frame = await this.waitForSummaryHeading('screen 4 (Resumen del envío)');

      const formHash = hashApprovalPayload(approval.payload);
      const approvedHash = approval.approvedHash.trim().toLowerCase();
      if (approvedHash === '' || formHash !== approvedHash) {
        const details = [
          `approved hash: ${approvedHash === '' ? '(empty)' : approvedHash}`,
          `form hash:     ${formHash}`,
          'the panel no longer holds the approved payload, so nothing was clicked',
        ];
        throw new ExecutorError('refusing to create the shipment: the form does not match the approved payload hash', details);
      }

      const recipientName = [approval.payload.customer.name, approval.payload.customer.lastName]
        .map((part) => part.trim())
        .filter((part) => part !== '')
        .join(' ');
      if (recipientName !== '' && !(await this.textPresent(frame, recipientName))) {
        const details = [
          `approved recipient: ${JSON.stringify(recipientName)}`,
          'the summary does not name this recipient, so it may be a stale screen',
          ...(await this.describe(frame)),
        ];
        throw new ExecutorError('refusing to create the shipment: the summary does not show the approved recipient', details);
      }

      const button = frame.getByRole('button', { name: copyPattern(CREATE_BUTTON, { exact: true }) }).first();
      if (!(await button.isVisible().catch(() => false))) {
        throw new ExecutorError(`the "${CREATE_BUTTON}" button is not visible; nothing was clicked`, await this.describe(frame));
      }

      this.createAttempted = true;
      this.note(`clicking "${CREATE_BUTTON}" once (approved hash ${approvedHash.slice(0, 12)}…)`);
      let clickError: string | null = null;
      try {
        await button.click({ timeout: this.timeoutMs });
      } catch (error) {
        clickError = messageOf(error);
      }

      const detailFrame = await this.waitForDetailFrame(clickError);
      const detail = await this.detailFrom(detailFrame);
      const unpaidProblem = labelUnpaidProblem(detail);
      if (unpaidProblem !== null) {
        throw new ExecutorError(unpaidProblem.message, [
          ...unpaidProblem.details,
          ...(await this.describe(detailFrame)),
        ]);
      }
      return detail;
    } catch (error) {
      if (wasClicked || this.createAttempted) throw error;
      throw asPreClickAbort('create gates (summary screen 4)', error);
    }
  }

  private async waitForDetailFrame(clickError: string | null): Promise<Frame> {
    const frame = await poll(
      async () => {
        for (const entry of this.frameEntries()) {
          if ((await this.findShipmentId(entry.frame)) !== null) {
            this.detailPage = entry.page;
            return entry.frame;
          }
        }
        return null;
      },
      { timeoutMs: this.timeoutMs },
    );
    if (frame !== null) return frame;

    const details = [
      `after one click on "${CREATE_BUTTON}", no shipment detail page (heading matching ${SHIPMENT_ID_PATTERN}) appeared within ${this.timeoutMs}ms`,
      'the outcome is UNKNOWN: the shipment may or may not exist',
      'do not retry and do not click again; reconcile against the shipments list first (S11)',
      ...(clickError === null ? [] : [`the click itself raised: ${clickError}`]),
      ...(await this.describe()),
    ];
    throw new UnknownOutcomeError('unknown outcome after clicking "Crear envío"', details);
  }

  /**
   * The shipment id heading, read as the panel shows it: `{ heading, id }`, or
   * `null` when the frame is not the detail page. The raw heading text is kept as
   * evidence; only its `#EM<number>` shape is asserted.
   */
  private async readShipmentHeading(frame: Frame): Promise<{ heading: string; id: string } | null> {
    const heading = frame.getByRole('heading', { name: SHIPMENT_ID_PATTERN }).first();
    if ((await heading.count().catch(() => 0)) > 0) {
      const headingText = compactText(await heading.innerText({ timeout: 3_000 }).catch(() => ''));
      const id = extractShipmentId(headingText);
      if (id !== null) return { heading: headingText, id };
    }
    const anyText = frame.getByText(SHIPMENT_ID_PATTERN).first();
    if ((await anyText.count().catch(() => 0)) > 0) {
      const headingText = compactText(await anyText.innerText({ timeout: 3_000 }).catch(() => ''));
      const id = extractShipmentId(headingText);
      if (id !== null) return { heading: headingText, id };
    }
    return null;
  }

  private async findShipmentId(frame: Frame): Promise<string | null> {
    const found = await this.readShipmentHeading(frame);
    return found === null ? null : found.id;
  }

  /** Detail page readback: id, status badges, cards, unpaid-label evidence. */
  async readShipmentDetail(): Promise<ShipmentDetailReadback> {
    const frame = await this.waitForDetailFrame(null);
    return this.detailFrom(frame);
  }

  private async detailFrom(frame: Frame): Promise<ShipmentDetailReadback> {
    const found = await this.readShipmentHeading(frame);
    if (found === null) {
      throw new UnknownOutcomeError(
        'the current panel screen is not the shipment detail page (no "#EM<number>" heading)',
        await this.describe(frame),
      );
    }

    // Read the badge text itself, then compare it; a canonical name is never
    // recorded in place of what the panel actually showed.
    const badgeTexts = await this.readBadgeTexts(frame);
    const statusBadges = DETAIL_STATUS_BADGES.filter((badge) =>
      badgeTexts.some((text) => textContains(text, badge)),
    );

    const cards: CardReadback[] = [];
    for (const title of DETAIL_CARDS) {
      const present = await this.textPresent(frame, title);
      cards.push({ title, present, text: present ? await this.containerText(frame, title) : null });
    }

    const buyCard = cards.find((card) => card.title === COMPRAR_CARD);
    const buttonNames = await this.readButtonNames(frame);
    return {
      url: frame.url(),
      shipmentId: found.id,
      shipmentIdHeading: found.heading === '' ? null : found.heading,
      statusBadges,
      badgeTexts,
      cards,
      // Informational: the report keeps this copy, no assertion is made over it.
      buyCardText: buyCard?.text ?? null,
      buttonNames,
      // `Comprar` is inspected, never clicked: this module has no purchase action.
      buyButtonVisible: buttonNames.some((name) => textContains(name, COMPRAR_BUTTON)),
      bodyText: await this.bodyText(frame),
    };
  }

  /** Badge text as shown, for each known badge that is present. */
  private async readBadgeTexts(frame: Frame): Promise<string[]> {
    const texts: string[] = [];
    for (const badge of DETAIL_STATUS_BADGES) {
      const locator = frame.getByText(copyPattern(badge)).first();
      if ((await locator.count().catch(() => 0)) === 0) continue;
      const text = compactText(await locator.innerText({ timeout: 3_000 }).catch(() => ''));
      if (text !== '' && !texts.includes(text)) texts.push(text);
    }
    return texts;
  }

  /**
   * Accessible name of every visible button: `aria-label`, else its text, else
   * `title`. Read once, so `isVisible()`-style assertions and the error evidence
   * can never disagree about what the page showed.
   */
  private async readButtonNames(frame: Frame): Promise<string[]> {
    const buttons = frame.getByRole('button');
    const count = await buttons.count().catch(() => 0);
    const names: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const button = buttons.nth(index);
      if (!(await button.isVisible().catch(() => false))) continue;
      const ariaLabel = compactText((await button.getAttribute('aria-label').catch(() => null)) ?? '');
      const title = compactText((await button.getAttribute('title').catch(() => null)) ?? '');
      const text = compactText(await button.innerText({ timeout: 2_000 }).catch(() => ''));
      const name = ariaLabel !== '' ? ariaLabel : text !== '' ? text : title;
      if (name !== '' && !names.includes(name)) names.push(name);
    }
    return names;
  }

  /** Asserts the detail page proves the label is still unpaid. Clicking `Comprar` is impossible here. */
  async assertLabelUnpaid(): Promise<void> {
    const frame = await this.waitForDetailFrame(null);
    const detail = await this.detailFrom(frame);
    const problem = labelUnpaidProblem(detail);
    if (problem !== null) {
      throw new ExecutorError(problem.message, [...problem.details, ...(await this.describe(frame))]);
    }
  }

  // ------------------------------------------------------ unknown outcome

  /**
   * Read-only reconciliation after an unknown creation outcome (S11).
   *
   * Opens the Envío Nube dashboard (`#/dashboard`) in a **new tab** and searches
   * its visible text for the postal code and the recipient name. Row-level
   * selectors of the shipment list were never verified, so this deliberately
   * reports raw matches instead of interpreting them: nothing is clicked, no
   * retry is attempted, and a human confirms the row.
   */
  async reconcileUnknownOutcome(input: { zipCode: string; recipientName: string }): Promise<ReconciliationReport> {
    const dashboardUrl = adminAppDashboardUrl();
    const method =
      'read-only: opened the Envío Nube dashboard (#/dashboard) in a new tab and searched its visible text for the postal code and the recipient name; no row selector was assumed, nothing was clicked, and no retry was attempted';
    let dashboardPage: Page | null = null;
    try {
      dashboardPage = await this.page.context().newPage();
      await dashboardPage.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
      const page = dashboardPage;
      const frame = await poll(
        async () => {
          for (const candidate of page.frames()) {
            if (candidate.url().includes(ENVIO_NUBE_FRAME_HOST)) return candidate;
          }
          return null;
        },
        { timeoutMs: this.timeoutMs },
      );
      const text = frame === null ? '' : await this.bodyText(frame, 12_000);
      const needles = [input.zipCode, input.recipientName]
        .map((needle) => needle.trim().toLowerCase())
        .filter((needle) => needle !== '');
      const matches: string[] = [];
      for (const line of text.split('\n')) {
        const compact = line.replace(/\s+/g, ' ').trim();
        if (compact === '') continue;
        const lower = compact.toLowerCase();
        if (needles.some((needle) => lower.includes(needle))) {
          const entry = compact.slice(0, 200);
          if (!matches.includes(entry)) matches.push(entry);
        }
      }
      return {
        dashboardUrl,
        frameUrl: frame === null ? null : frame.url(),
        searchedFor: { zipCode: input.zipCode, recipientName: input.recipientName },
        matches: matches.slice(0, 25),
        bodyText: text.slice(0, 6_000),
        method,
        interpretation:
          matches.length === 0
            ? 'no visible text matched the postal code or the recipient name; that does NOT prove the shipment was not created (the list may be paginated, filtered or not refreshed), so a human must check the shipment list'
            : 'visible text matched the search terms; a human must confirm which row belongs to this run before any further action',
      };
    } catch (error) {
      return {
        dashboardUrl,
        frameUrl: null,
        searchedFor: { zipCode: input.zipCode, recipientName: input.recipientName },
        matches: [],
        bodyText: '',
        method,
        interpretation: `the reconciliation attempt itself failed (${messageOf(error)}); the outcome remains UNKNOWN and only a human can resolve it`,
      };
    } finally {
      if (dashboardPage !== null) {
        await dashboardPage.close().catch(() => {
          // Closing the extra tab is best-effort; a failure here cannot change the outcome.
        });
      }
    }
  }
}

/** Collapse whitespace; `''` for null/undefined. */
function compactText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/** Every delivery radio with its group and state, one line each, for loud stops. */
function formatCarrierDiagnostics(options: readonly CarrierOptionDiagnostic[], fieldName: string): string[] {
  if (options.length === 0) return [`no ${fieldName} radios were found on the screen`];
  const lines = [`delivery radios read from the panel (${options.length}):`];
  for (const option of options) {
    lines.push(
      `  [${option.index}] group=${option.group} disabled=${option.disabled} checked=${option.checked} visible=${option.visible} name=${JSON.stringify(option.accessibleName)}`,
    );
  }
  return lines;
}

/** `#EM1053` out of arbitrary text, or `null`. Case-insensitive: the id is structural. */
function extractShipmentId(text: string): string | null {
  const match = SHIPMENT_ID_PATTERN.exec(text);
  if (match === null) return null;
  return match[0];
}

/**
 * The branch-name matching rule, as pure data so it can be tested offline.
 *
 * **The address pair — last word + number — is the identity of a branch** (the
 * operator's rule: within one postal code addresses never repeat, so one word
 * and the number are enough; from the live CP 4800 Jujuy failure: the panel
 * offered exactly
 * `"Sucursal - Gral. San Martin 979 San Salvador de Jujuy, Jujuy"` for an
 * approved `"Gral. San Martin 979 San Salvador de Jujuy"` — the same branch,
 * decorated). In priority order:
 *
 * 1. **Word+number pair (primary).** Parse `(word, number)` out of the approved
 *    name (last digit token = number, the **last non-digit word immediately
 *    before it** = word, normalized in `./branch`): `beiro 4470` and
 *    `Av Beiro 4470` both parse to `(beiro, 4470)` — `av`-style street-type
 *    prefixes drop out by themselves. Every option whose text contains that
 *    same pair adjacent — the word **immediately followed by the number as a
 *    whole token** — is a candidate. An option that merely mentions the word
 *    without the number (e.g. inside its own `entre calles` description:
 *    `Lamadrid, 177 Entrecalles gral san martin e independencia`) is **not** on
 *    that address and is never a candidate — the live CP 4600 Jujuy failure
 *    counted such a mention and produced a false ambiguity that blocked the
 *    real `Gral. San Martín, 979` branch. Prefixes (`Sucursal -`,
 *    `Punto Andreani Hop`), city names and schedule text are decoration and do
 *    not participate.
 *    Exactly one candidate → `unique`. More than one option carrying the
 *    identical word+number pair (genuinely co-located duplicate points) →
 *    `ambiguous`, naming both.
 * 2. **Full-text fallback (secondary).** Only when no pair can be parsed from
 *    the approved name (e.g. the customer wrote only a branch name with no
 *    number): exact text after `normalizeText` — the same comparison form as
 *    every other panel text. Option `value`s are UUIDs and are never compared;
 *    there is no index and no fuzzy matching.
 *
 * Never a near match: every non-unique outcome is a rejection. A word-only
 * match whose number differs is reported as a near match and never selected —
 * choosing a nearby branch is a wrong shipment (R12).
 */
export function matchSucursalBranch(requested: string, options: readonly BranchOption[]): BranchMatch {
  const wanted = normalizeText(requested);
  if (wanted === '') {
    return { kind: 'none', options, nearMatches: [], rule: 'full-text', reason: 'empty-request', pair: null };
  }

  // Primary rule: the address pair is the branch identity. A candidate is an
  // option carrying the **pair adjacent** — the word immediately followed by
  // the number as a whole token. A word mention without the number (e.g.
  // another option's `entre calles` description) is not on that address.
  const pair = parseStreetNumberPair(requested);
  if (pair !== null) {
    const pairCandidates = options.filter((option) => textContainsStreetNumberPair(option.text, pair));
    if (pairCandidates.length > 1) {
      return {
        kind: 'ambiguous',
        matches: pairCandidates,
        rule: 'street-number-pair',
        reason: 'street-shared-by-multiple-options',
        pair,
      };
    }
    if (pairCandidates.length === 1) {
      return { kind: 'unique', option: pairCandidates[0]!, rule: 'street-number-pair' };
    }
    // Zero pair candidates: the word may still be mentioned (different
    // number, or decoration text) — report those as near matches, never
    // selected; a word-only match is a different branch (R12).
    const nearMatches = options.filter((option) => textContainsStreetTokens(option.text, pair.street));
    return {
      kind: 'none',
      options,
      nearMatches,
      rule: 'street-number-pair',
      reason: nearMatches.length > 0 ? 'street-without-number' : 'no-option-contains-street',
      pair,
    };
  }

  // Fallback: no (word, number) pair could be parsed from the approved name
  // (e.g. the customer wrote only a branch name with no number) → exact text.
  const exact = options.filter((option) => normalizeText(option.text) === wanted);
  if (exact.length === 1) return { kind: 'unique', option: exact[0]!, rule: 'full-text' };
  if (exact.length > 1) {
    return {
      kind: 'ambiguous',
      matches: exact,
      rule: 'full-text',
      reason: 'multiple-options-equal-after-normalization',
      pair: null,
    };
  }
  const nearMatches = options.filter((option) => {
    const text = normalizeText(option.text);
    return text !== '' && (text.includes(wanted) || wanted.includes(text));
  });
  return {
    kind: 'none',
    options,
    nearMatches,
    rule: 'full-text',
    reason: 'no-exact-text-match',
    pair: null,
  };
}

/** Human label of a matching rule, used in every rejection (R12). */
function branchRuleLabel(rule: BranchMatchRule): string {
  return rule === 'street-number-pair' ? 'street+number pair' : 'full text (exact after normalization)';
}

/**
 * The rejection lines naming **which rule failed** (street-pair vs full-text)
 * and what was parsed from the approved name (R12).
 */
export function branchMatchFailureDetails(
  match: Exclude<BranchMatch, { kind: 'unique' }>,
): string[] {
  const label = branchRuleLabel(match.rule);
  if (match.rule === 'street-number-pair' && match.pair !== null) {
    const parsed = `parsed street+number pair: street ${JSON.stringify(match.pair.street)}, number ${JSON.stringify(match.pair.number)}`;
    if (match.kind === 'none') {
      if (match.reason === 'street-without-number') {
        return [
          `matching rule that failed: ${label} — ${parsed}; the street matches ${match.nearMatches.length} option(s) but none carries the approved number, and a street-only match is never selected`,
        ];
      }
      return [`matching rule that failed: ${label} — ${parsed}; no dropdown option contains the pair`];
    }
    return [
      `matching rule that failed: ${label} — ${parsed}; ${match.matches.length} options carry the identical street+number pair (genuinely co-located duplicate points)`,
    ];
  }
  if (match.kind === 'ambiguous') {
    return [
      `matching rule that failed: ${label} — ${match.matches.length} options equal the approved name after normalization`,
    ];
  }
  return [`matching rule that failed: ${label} — no option equals the approved name after normalization`];
}

/** The three structural facts that prove the label has never been paid (S12). */
export type UnpaidLabelCheckName = 'shipmentId' | 'statusBadge' | 'buyButton';

/**
 * What the detail page actually showed, as read. Pure data, so the proof can be
 * tested without a browser and can never depend on the panel's prose.
 */
export interface UnpaidLabelEvidence {
  /** Text of the heading that carries the shipment id, or `null` when none was found. */
  shipmentIdHeading: string | null;
  /** Status badge text exactly as the panel showed it. */
  badgeTexts: readonly string[];
  /** Accessible names of every visible button on the page. */
  buttonNames: readonly string[];
}

/** One structural check that did not hold, with what was read instead. */
export interface UnpaidLabelFailure {
  check: UnpaidLabelCheckName;
  /** The requirement, in words: what the detail page must show. */
  requirement: string;
  /** What was actually read. */
  observed: string;
}

/**
 * The checks, as data: one line per fact, in the order they are evaluated. The
 * prose in the `Comprar etiqueta` card is deliberately absent — it is copy, not
 * state, and asserting over it is what reported a created shipment as unproven.
 */
export const UNPAID_LABEL_CHECKS: readonly { check: UnpaidLabelCheckName; requirement: string }[] = [
  { check: 'shipmentId', requirement: 'the detail heading matches "#EM<number>"' },
  { check: 'statusBadge', requirement: `a status badge reads "${UNPAID_STATUS_BADGE}"` },
  {
    check: 'buyButton',
    requirement: `a visible button whose accessible name contains "${COMPRAR_BUTTON}" is present`,
  },
];

function quoteList(values: readonly string[]): string {
  if (values.length === 0) return '(none)';
  return values.map((value) => JSON.stringify(value)).join(', ');
}

/**
 * Which of the three structural checks failed. Empty means the label is proven
 * unpaid. Every comparison is case- and accent-insensitive (`sameText` /
 * `textContains`), so the panel's spelling of its own copy can never decide the
 * verdict.
 *
 * The badge check reads the text rather than demanding whole-string equality: a
 * badge node may carry a date or an icon label beside its words, and that
 * decoration is not a different state. The badge copy has to *be* there; nothing
 * more is asked of it.
 */
export function unpaidLabelFailures(evidence: UnpaidLabelEvidence): UnpaidLabelFailure[] {
  const heading = evidence.shipmentIdHeading;
  const observed: Record<UnpaidLabelCheckName, string> = {
    shipmentId: heading === null ? 'no heading was read' : `the heading read ${JSON.stringify(heading)}`,
    statusBadge: `the badge text read ${quoteList(evidence.badgeTexts)}`,
    buyButton: `the buttons read ${quoteList(evidence.buttonNames)}`,
  };
  const holds: Record<UnpaidLabelCheckName, boolean> = {
    shipmentId: heading !== null && SHIPMENT_ID_PATTERN.test(heading),
    statusBadge: evidence.badgeTexts.some((text) => textContains(text, UNPAID_STATUS_BADGE)),
    buyButton: evidence.buttonNames.some((name) => textContains(name, COMPRAR_BUTTON)),
  };
  return UNPAID_LABEL_CHECKS.filter(({ check }) => !holds[check]).map(({ check, requirement }) => ({
    check,
    requirement,
    observed: observed[check],
  }));
}

/**
 * Why the detail page does not prove the label is unpaid — or `null` when it
 * does. Read-only: nothing here can buy.
 *
 * The failure names every check that did not hold and prints the headings, badge
 * text and button names that were actually read, so a mismatch is diagnosable
 * without a second run.
 */
export function labelUnpaidProblem(detail: ShipmentDetailReadback): { message: string; details: string[] } | null {
  const failures = unpaidLabelFailures({
    shipmentIdHeading: detail.shipmentIdHeading,
    badgeTexts: detail.badgeTexts,
    buttonNames: detail.buttonNames,
  });
  if (failures.length === 0) return null;

  const failed = failures.map((failure) => failure.check).join(', ');
  const message =
    `the shipment detail page does not prove the label is unpaid: ${failures.length} of ${UNPAID_LABEL_CHECKS.length} ` +
    `structural checks failed (${failed}); visible headings ${quoteList(detail.shipmentIdHeading === null ? [] : [detail.shipmentIdHeading])}; ` +
    `badge text ${quoteList(detail.badgeTexts)}; button names ${quoteList(detail.buttonNames)}`;

  const details: string[] = [`shipment id: ${detail.shipmentId}`, 'structural proof of the unpaid label (three checks):'];
  for (const { check, requirement } of UNPAID_LABEL_CHECKS) {
    const failure = failures.find((candidate) => candidate.check === check);
    details.push(
      `  ${failure === undefined ? 'PASS' : 'FAIL'} ${check}: ${requirement}${failure === undefined ? '' : `; observed ${failure.observed}`}`,
    );
  }
  details.push(
    `informational only, never asserted: "${COMPRAR_CARD}" card copy = ${JSON.stringify(detail.buyCardText)}`,
  );
  return { message, details };
}

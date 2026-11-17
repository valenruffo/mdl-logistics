import type { PackageDefaults } from './config';
import type { ProvinceCode } from './provinces';

/**
 * The panel anchors this MVP fills, exactly as captured by DOM inspection in
 * docs/plans/mvp-01-manual-shipment.md §4c. `address.province` is a native
 * `<select>` whose `value` is the letter code, so it is written by code and
 * re-read by name; every other anchor is a plain `[name=...]` input.
 */
export const PANEL_ANCHORS = {
  zipCode: 'zipCode',
  province: 'address.province',
  city: 'address.city',
  address: 'address.address',
  number: 'address.number',
  complement: 'address.complement',
  neighborhood: 'address.neighborhood',
  name: 'customer.name',
  lastName: 'customer.lastName',
} as const;

export type PanelAnchor = (typeof PANEL_ANCHORS)[keyof typeof PANEL_ANCHORS];

/** Section headings of the pasted message. */
export type MessageSectionKey = 'destination' | 'recipient';

/** Every `Label: value` field of the pasted message. */
export type MessageFieldKey =
  | 'province'
  | 'zipCode'
  | 'city'
  | 'address'
  | 'number'
  | 'complement'
  | 'neighborhood'
  | 'fullName';

/** Field keys plus the structural `section` pseudo-field used for heading issues. */
export type FieldKey = MessageFieldKey | 'section';

/**
 * A field the message did not carry (absent line, or present with an empty
 * value). Defaults are never substituted for these.
 */
export interface MissingField {
  field: FieldKey;
  /** Panel anchor the field would fill, when it maps 1:1 to an anchor. */
  anchor?: PanelAnchor;
  /** Message label as declared in MESSAGE_LABELS. */
  label: string;
}

/** A field that was present but could not be accepted as written. */
export interface InvalidField {
  field: FieldKey;
  anchor?: PanelAnchor;
  label: string;
  /** The normalized value that was rejected. */
  value: string;
  /** Why it was rejected, and what would have been accepted. */
  reason: string;
}

/** Rejection payload. Every category is filled, never short-circuited. */
export interface ParseFailure {
  ok: false;
  missing: MissingField[];
  invalid: InvalidField[];
  /** Labels (or headings) present in the message that the format does not define. */
  unknownLabels: string[];
}

/** Why a value in the payload was computed rather than parsed. */
export type DerivationRule =
  /**
   * `address.neighborhood := address.city`, used **only** when the message omits
   * `Barrio` (Tiendanube artifact, plan §7).
   */
  | 'neighborhood-from-city'
  /** `Nombre completo` split into `customer.name` + `customer.lastName`. */
  | 'full-name-split'
  /** An all-lowercase name was title-cased for display and for the panel. */
  | 'title-case';

/**
 * Marks a payload value the operator must confirm in the preview instead of
 * trusting blindly (R12: a derivation is not an invention, but it is a guess
 * until approved).
 */
export interface Derivation {
  anchor: PanelAnchor;
  rule: DerivationRule;
  /** Anchor the value was derived from, when it comes from another anchor. */
  from: PanelAnchor | null;
  /** Human-readable one-liner for the preview. */
  note: string;
}

/** Kinds of non-blocking finding a successful parse can carry. */
export type WarningCode = 'neighborhood-differs-from-city';

/**
 * A non-blocking finding. It never blocks the shipment; the preview shows it so
 * the operator approves what is actually written (R10, R12).
 */
export interface ParseWarning {
  code: WarningCode;
  field: FieldKey;
  /** Panel anchor the finding concerns, when it maps to one. */
  anchor?: PanelAnchor;
  /** Human-readable, naming both conflicting values. */
  message: string;
}

/**
 * Everything needed to fill panel screens 1 and 3 (plan §4c) — and nothing else.
 * `address.province` is resolved to the panel's own option so the executor can
 * write by `value` and assert by option text.
 */
export interface ShipmentRequest {
  /** Panel `zipCode`: 4 digits or an 8-character CPA, uppercase. */
  zipCode: string;
  address: {
    /** Panel `address.province`: write `code`, re-read and compare `name`. */
    province: { code: ProvinceCode; name: string };
    /** Panel `address.city` — free text, as the operator wrote it. */
    city: string;
    /** Panel `address.address` — the street ("Calle" in the message). */
    address: string;
    /** Panel `address.number` — a separate field in the panel. */
    number: string;
    /** Panel `address.complement` — optional in the panel, null when absent. */
    complement: string | null;
    /**
     * Panel `address.neighborhood` — the message's `Barrio` when it carries one,
     * otherwise derived from `city` and marked in `derived`.
     */
    neighborhood: string;
  };
  customer: {
    /** Panel `customer.name` — first token of `Nombre completo`. */
    name: string;
    /** Panel `customer.lastName` — the remaining tokens, null when there is one. */
    lastName: string | null;
  };
  /** Panel screen 1 package fields, in centimetres and grams (S7). */
  box: PackageDefaults;
  /** Values that were derived rather than parsed, for the preview. */
  derived: Derivation[];
}

/** Accepted message: the request to fill, plus anything the preview must flag. */
export interface ParseSuccess {
  ok: true;
  value: ShipmentRequest;
  /** Non-blocking findings (e.g. Barrio differs from Ciudad). May be empty. */
  warnings: ParseWarning[];
}

/** Discriminated result of the parser: a validated request, or a loud rejection. */
export type ParseResult = ParseSuccess | ParseFailure;

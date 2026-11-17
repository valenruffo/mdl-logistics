import { DEFAULT_CONFIG, type ProjectConfig } from './config';
import { MESSAGE_LABELS } from './labels';
import {
  collapseWhitespace,
  isAllLowercase,
  normalizeLookupKey,
  splitFullName,
  stripFormattingMarkers,
  titleCase,
} from './normalize';
import { POSTAL_CODE_HINT, isPostalCode, normalizePostalCode } from './postal-code';
import { resolveProvince, type ProvinceOption } from './provinces';
import {
  PANEL_ANCHORS,
  type Derivation,
  type FieldKey,
  type InvalidField,
  type MessageFieldKey,
  type MessageSectionKey,
  type MissingField,
  type PanelAnchor,
  type ParseResult,
  type ParseWarning,
  type ShipmentRequest,
} from './types';

/**
 * Deterministic parser for the pasted WhatsApp message (plan §7, B1 / §4b, S1–S3).
 *
 * Contract: no LLM, no network, no fuzzy matching, no defaults.
 * - WhatsApp formatting markers (`*`, `_`, `~`, `` ` ``) are stripped at the
 *   edges of labels, headings and values before any comparison. A marker inside
 *   a value is operator data and survives.
 * - An unknown label or section heading is a rejection (`unknownLabels`), never
 *   ignored — including one that is still unknown after stripping.
 * - Every missing required field is reported at once (`missing`).
 * - Every present but unusable value is reported with a reason (`invalid`).
 * - A rejection never carries a payload, so nothing can be filled by accident.
 * - `Barrio` is parsed when the message provides it, derived from `Ciudad` only
 *   when it does not, and a differing pair raises a non-blocking warning
 *   (`warnings`) instead of a rejection.
 */

interface FieldSpec {
  key: MessageFieldKey;
  label: string;
  section: MessageSectionKey;
  anchor: PanelAnchor;
  required: boolean;
}

interface SectionSpec {
  key: MessageSectionKey;
  label: string;
}

/** Every field the format defines, keyed off MESSAGE_LABELS (single source of truth). */
const FIELD_SPECS: readonly FieldSpec[] = [
  {
    key: 'province',
    label: MESSAGE_LABELS.fields.province,
    section: 'destination',
    anchor: PANEL_ANCHORS.province,
    required: true,
  },
  {
    key: 'zipCode',
    label: MESSAGE_LABELS.fields.zipCode,
    section: 'destination',
    anchor: PANEL_ANCHORS.zipCode,
    required: true,
  },
  {
    key: 'city',
    label: MESSAGE_LABELS.fields.city,
    section: 'destination',
    anchor: PANEL_ANCHORS.city,
    required: true,
  },
  {
    key: 'address',
    label: MESSAGE_LABELS.fields.address,
    section: 'destination',
    anchor: PANEL_ANCHORS.address,
    required: true,
  },
  {
    key: 'number',
    label: MESSAGE_LABELS.fields.number,
    section: 'destination',
    anchor: PANEL_ANCHORS.number,
    required: true,
  },
  {
    key: 'complement',
    label: MESSAGE_LABELS.fields.complement,
    section: 'destination',
    anchor: PANEL_ANCHORS.complement,
    required: false,
  },
  {
    key: 'neighborhood',
    label: MESSAGE_LABELS.fields.neighborhood,
    section: 'destination',
    anchor: PANEL_ANCHORS.neighborhood,
    required: false,
  },
  {
    key: 'fullName',
    label: MESSAGE_LABELS.fields.fullName,
    section: 'recipient',
    anchor: PANEL_ANCHORS.name,
    required: true,
  },
];

const SECTION_SPECS: readonly SectionSpec[] = [
  { key: 'destination', label: MESSAGE_LABELS.sections.destination },
  { key: 'recipient', label: MESSAGE_LABELS.sections.recipient },
];

const FIELD_BY_LABEL = new Map<string, FieldSpec>(
  FIELD_SPECS.map((spec) => [normalizeLookupKey(spec.label), spec]),
);

const SPEC_BY_KEY = new Map<MessageFieldKey, FieldSpec>(
  FIELD_SPECS.map((spec) => [spec.key, spec]),
);

const SECTION_BY_LABEL = new Map<string, SectionSpec>(
  SECTION_SPECS.map((spec) => [normalizeLookupKey(spec.label), spec]),
);

const SECTION_LABEL_BY_KEY = new Map<MessageSectionKey, string>(
  SECTION_SPECS.map((spec) => [spec.key, spec.label]),
);

const TITLE_KEY = normalizeLookupKey(MESSAGE_LABELS.title);

function sectionLabel(key: MessageSectionKey): string {
  return SECTION_LABEL_BY_KEY.get(key) ?? key;
}

function compareFields(a: FieldKey, b: FieldKey): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

interface FieldIssueTarget {
  key: MessageFieldKey;
  label: string;
  anchor: PanelAnchor;
}

function invalidField(target: FieldIssueTarget, value: string, reason: string): InvalidField {
  return { field: target.key, anchor: target.anchor, label: target.label, value, reason };
}

function issueTarget(spec: FieldSpec): FieldIssueTarget {
  return { key: spec.key, label: spec.label, anchor: spec.anchor };
}

/** Thrown only if this module's own invariants are broken — never for user input. */
function invariant<T>(value: T | undefined, description: string): T {
  if (value === undefined) {
    throw new Error(`parse-message invariant violated: ${description}`);
  }
  return value;
}

/**
 * Parses and validates one pasted message.
 *
 * @param text   the message exactly as pasted (CRLF or LF)
 * @param config project-declared package defaults (S7); validated at load
 */
export function parseMessage(text: string, config: ProjectConfig = DEFAULT_CONFIG): ParseResult {
  const fields = new Map<MessageFieldKey, string>();
  const missing: MissingField[] = [];
  const invalid: InvalidField[] = [];
  const unknownLabels: string[] = [];
  const seenSections = new Set<MessageSectionKey>();
  let currentSection: MessageSectionKey | null = null;

  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  for (const rawLine of lines) {
    const line = collapseWhitespace(rawLine);
    if (line === '') continue;

    // WhatsApp wraps labels and headings in markers (`*Destino*`), so every
    // comparison happens on the marker-free text. A label stays unknown if it
    // is still unknown after stripping.
    const content = stripFormattingMarkers(line);
    if (content === '') continue;

    // The document title is decorative: tolerated, never required, ignored.
    if (normalizeLookupKey(content) === TITLE_KEY) continue;

    const section = SECTION_BY_LABEL.get(normalizeLookupKey(content));
    if (section !== undefined) {
      if (seenSections.has(section.key)) {
        invalid.push({
          field: 'section',
          label: section.label,
          value: content,
          reason: `duplicate section "${section.label}": the message must contain each section at most once`,
        });
      }
      seenSections.add(section.key);
      currentSection = section.key;
      continue;
    }

    const separator = line.indexOf(':');
    if (separator === -1) {
      unknownLabels.push(content);
      continue;
    }

    // Markers are stripped at the edges of the label and of the value; a marker
    // inside a value is operator data and is left untouched.
    const label = stripFormattingMarkers(line.slice(0, separator));
    const value = stripFormattingMarkers(line.slice(separator + 1));
    if (label === '') {
      unknownLabels.push(content);
      continue;
    }

    const spec = FIELD_BY_LABEL.get(normalizeLookupKey(label));
    if (spec === undefined) {
      unknownLabels.push(label);
      continue;
    }

    if (currentSection === null) {
      invalid.push({
        field: spec.key,
        label,
        value,
        reason: `"${label}" appears before any known section heading`,
      });
      continue;
    }

    if (spec.section !== currentSection) {
      invalid.push({
        field: spec.key,
        label,
        value,
        reason: `"${spec.label}" belongs to section "${sectionLabel(spec.section)}" but appears under "${sectionLabel(currentSection)}"`,
      });
      continue;
    }

    if (fields.has(spec.key)) {
      invalid.push({
        field: spec.key,
        label,
        value,
        reason: `duplicate "${spec.label}": it already appeared earlier in the message`,
      });
      continue;
    }

    fields.set(spec.key, value);
  }

  // Missing required fields: absent line, or present with an empty value.
  for (const spec of FIELD_SPECS) {
    if (!spec.required) continue;
    const value = fields.get(spec.key);
    if (value === undefined || value === '') {
      fields.delete(spec.key);
      missing.push({ field: spec.key, anchor: spec.anchor, label: spec.label });
    }
  }
  missing.sort((a, b) => compareFields(a.field, b.field));

  // Field-level validation of everything that was present.
  let province: ProvinceOption | undefined;
  const rawProvince = fields.get('province');
  if (rawProvince !== undefined) {
    const resolution = resolveProvince(rawProvince);
    if (resolution.ok) {
      province = resolution.value;
    } else {
      invalid.push(
        invalidField(issueTarget(invariant(SPEC_BY_KEY.get('province'), 'province spec')), rawProvince, resolution.reason),
      );
    }
  }

  let zipCode: string | undefined;
  const rawZipCode = fields.get('zipCode');
  if (rawZipCode !== undefined) {
    const normalized = normalizePostalCode(rawZipCode);
    if (isPostalCode(normalized)) {
      zipCode = normalized;
    } else {
      invalid.push(
        invalidField(
          issueTarget(invariant(SPEC_BY_KEY.get('zipCode'), 'zipCode spec')),
          normalized,
          `postal code "${normalized}" is invalid: ${POSTAL_CODE_HINT}`,
        ),
      );
    }
  }

  let customer: { name: string; lastName: string | null } | undefined;
  let titleCased = false;
  const rawFullName = fields.get('fullName');
  if (rawFullName !== undefined) {
    const display = isAllLowercase(rawFullName) ? titleCase(rawFullName) : rawFullName;
    titleCased = display !== rawFullName;
    const split = splitFullName(display);
    if (split.name === '') {
      invalid.push(
        invalidField(
          issueTarget(invariant(SPEC_BY_KEY.get('fullName'), 'fullName spec')),
          rawFullName,
          'name is empty after normalization',
        ),
      );
    } else {
      customer = split;
    }
  }

  const city = fields.get('city');
  const street = fields.get('address');
  const number = fields.get('number');
  const complement = fields.get('complement');

  // Barrio is real parsed input. It is derived from Ciudad only when the message
  // omits it; a differing pair is reported as a warning, never rejected.
  const rawNeighborhood = fields.get('neighborhood');
  const parsedNeighborhood =
    rawNeighborhood === undefined || rawNeighborhood === '' ? null : rawNeighborhood;

  if (missing.length > 0 || invalid.length > 0 || unknownLabels.length > 0) {
    return { ok: false, missing, invalid, unknownLabels };
  }

  const resolvedProvince = invariant(province, 'province resolved after validation');
  const resolvedZipCode = invariant(zipCode, 'zipCode resolved after validation');
  const resolvedCustomer = invariant(customer, 'customer resolved after validation');
  const resolvedCity = invariant(city, 'city resolved after validation');
  const resolvedStreet = invariant(street, 'address resolved after validation');
  const resolvedNumber = invariant(number, 'number resolved after validation');

  const derived: Derivation[] = [];
  const warnings: ParseWarning[] = [];

  if (parsedNeighborhood === null) {
    derived.push({
      anchor: PANEL_ANCHORS.neighborhood,
      rule: 'neighborhood-from-city',
      from: PANEL_ANCHORS.city,
      note: `${PANEL_ANCHORS.neighborhood} := ${PANEL_ANCHORS.city} (message omitted "${MESSAGE_LABELS.fields.neighborhood}")`,
    });
  } else if (normalizeLookupKey(parsedNeighborhood) !== normalizeLookupKey(resolvedCity)) {
    warnings.push({
      code: 'neighborhood-differs-from-city',
      field: 'neighborhood',
      anchor: PANEL_ANCHORS.neighborhood,
      message:
        `"${MESSAGE_LABELS.fields.neighborhood}" ("${parsedNeighborhood}") differs from ` +
        `"${MESSAGE_LABELS.fields.city}" ("${resolvedCity}"): the parsed ${PANEL_ANCHORS.neighborhood} is kept. ` +
        'Confirm both values in the preview',
    });
  }

  derived.push(
    {
      anchor: PANEL_ANCHORS.name,
      rule: 'full-name-split',
      from: null,
      note: `first token of "${MESSAGE_LABELS.fields.fullName}"`,
    },
    {
      anchor: PANEL_ANCHORS.lastName,
      rule: 'full-name-split',
      from: null,
      note: `remaining tokens of "${MESSAGE_LABELS.fields.fullName}" (panel marks it optional)`,
    },
  );

  if (titleCased) {
    derived.push(
      {
        anchor: PANEL_ANCHORS.name,
        rule: 'title-case',
        from: null,
        note: 'an all-lowercase name was title-cased',
      },
      {
        anchor: PANEL_ANCHORS.lastName,
        rule: 'title-case',
        from: null,
        note: 'an all-lowercase name was title-cased',
      },
    );
  }

  const value: ShipmentRequest = {
    zipCode: resolvedZipCode,
    address: {
      province: { code: resolvedProvince.code, name: resolvedProvince.name },
      city: resolvedCity,
      address: resolvedStreet,
      number: resolvedNumber,
      complement: complement === undefined || complement === '' ? null : complement,
      neighborhood: parsedNeighborhood ?? resolvedCity,
    },
    customer: resolvedCustomer,
    box: { ...config.package },
    derived,
  };

  return { ok: true, value, warnings };
}

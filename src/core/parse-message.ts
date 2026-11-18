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
  type MessageFieldKey,
  type MessageModality,
  type MessageSectionKey,
  type InvalidField,
  type MissingField,
  type PanelAnchor,
  type ParseResult,
  type ParseWarning,
  type ShipmentRequest,
  type SucursalShipmentRequest,
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
 *
 * ## The format-version rule (Modalidad)
 *
 * `Modalidad` is optional **only** for backward compatibility: its absence means
 * the old format, and the old format only ever carried domicilio. That is a
 * rule about the *format version*, not an inference from which fields happen to
 * be present — the parser never guesses a modality from the field set. When
 * `Modalidad` is present it must be exactly `domicilio` or `sucursal`
 * (accent-, case- and whitespace-insensitive); anything else is a rejection.
 *
 * `Modalidad: domicilio` keeps the old required set unchanged. `Modalidad:
 * sucursal` switches it: `Sucursal (nombre)` + `Código postal` + `Nombre`
 * become required, `Email`/`Teléfono` stay optional, and the domicilio
 * destination fields (`Provincia`, `Ciudad`, `Calle`, `Número`, `Departamento`,
 * `Barrio`) and `Nombre completo` are **not** parsed — their presence is a
 * rejection naming them (R12: wrong-format data must never be silently
 * dropped). Symmetrically, a domicilio message must not carry the sucursal-only
 * labels; their presence is also a rejection naming them.
 *
 * `Sucursal (nombre)` is free text: trimmed, whitespace-collapsed, no other
 * normalization; it is validated later against the panel dropdown (executor
 * slice, after a DOM discovery pass).
 */

interface FieldSpec {
  key: MessageFieldKey;
  label: string;
  /**
   * Where the field must appear, per modality. `null` = at the top level of
   * the message (before any section heading).
   */
  section: Record<MessageModality, MessageSectionKey | null>;
  /** Whether the field is required, per modality. */
  required: Record<MessageModality, boolean>;
  /** The format versions that define this label at all. */
  modalities: readonly MessageModality[];
  /** Panel anchor, when one is observed; null for fields the executor slice will anchor. */
  anchor: PanelAnchor | null;
}

interface SectionSpec {
  key: MessageSectionKey;
  label: string;
}

const BOTH_MODALITIES: readonly MessageModality[] = ['domicilio', 'sucursal'];
const DOMICILIO_ONLY: readonly MessageModality[] = ['domicilio'];
const SUCURSAL_ONLY: readonly MessageModality[] = ['sucursal'];

/** The only accepted values of the `Modalidad` line, compared lookup-key form. */
const MODALITY_VALUES: Readonly<Record<MessageModality, string>> = {
  domicilio: normalizeLookupKey('domicilio'),
  sucursal: normalizeLookupKey('sucursal'),
};

/** Every field the format defines, keyed off MESSAGE_LABELS (single source of truth). */
const FIELD_SPECS: readonly FieldSpec[] = [
  {
    key: 'modalidad',
    label: MESSAGE_LABELS.fields.modalidad,
    section: { domicilio: null, sucursal: null },
    required: { domicilio: false, sucursal: false },
    modalities: BOTH_MODALITIES,
    anchor: null,
  },
  {
    key: 'zipCode',
    label: MESSAGE_LABELS.fields.zipCode,
    section: { domicilio: 'destination', sucursal: null },
    required: { domicilio: true, sucursal: true },
    modalities: BOTH_MODALITIES,
    anchor: PANEL_ANCHORS.zipCode,
  },
  {
    key: 'sucursal',
    label: MESSAGE_LABELS.fields.sucursal,
    section: { domicilio: null, sucursal: null },
    required: { domicilio: false, sucursal: true },
    modalities: SUCURSAL_ONLY,
    anchor: null,
  },
  {
    key: 'province',
    label: MESSAGE_LABELS.fields.province,
    section: { domicilio: 'destination', sucursal: null },
    required: { domicilio: true, sucursal: false },
    modalities: DOMICILIO_ONLY,
    anchor: PANEL_ANCHORS.province,
  },
  {
    key: 'city',
    label: MESSAGE_LABELS.fields.city,
    section: { domicilio: 'destination', sucursal: null },
    required: { domicilio: true, sucursal: false },
    modalities: DOMICILIO_ONLY,
    anchor: PANEL_ANCHORS.city,
  },
  {
    key: 'address',
    label: MESSAGE_LABELS.fields.address,
    section: { domicilio: 'destination', sucursal: null },
    required: { domicilio: true, sucursal: false },
    modalities: DOMICILIO_ONLY,
    anchor: PANEL_ANCHORS.address,
  },
  {
    key: 'number',
    label: MESSAGE_LABELS.fields.number,
    section: { domicilio: 'destination', sucursal: null },
    required: { domicilio: true, sucursal: false },
    modalities: DOMICILIO_ONLY,
    anchor: PANEL_ANCHORS.number,
  },
  {
    key: 'complement',
    label: MESSAGE_LABELS.fields.complement,
    section: { domicilio: 'destination', sucursal: null },
    required: { domicilio: false, sucursal: false },
    modalities: DOMICILIO_ONLY,
    anchor: PANEL_ANCHORS.complement,
  },
  {
    key: 'neighborhood',
    label: MESSAGE_LABELS.fields.neighborhood,
    section: { domicilio: 'destination', sucursal: null },
    required: { domicilio: false, sucursal: false },
    modalities: DOMICILIO_ONLY,
    anchor: PANEL_ANCHORS.neighborhood,
  },
  {
    key: 'fullName',
    label: MESSAGE_LABELS.fields.fullName,
    section: { domicilio: 'recipient', sucursal: null },
    required: { domicilio: true, sucursal: false },
    modalities: DOMICILIO_ONLY,
    anchor: PANEL_ANCHORS.name,
  },
  {
    key: 'nombre',
    label: MESSAGE_LABELS.fields.nombre,
    section: { domicilio: null, sucursal: 'recipient' },
    required: { domicilio: false, sucursal: true },
    modalities: SUCURSAL_ONLY,
    anchor: null,
  },
  {
    key: 'apellido',
    label: MESSAGE_LABELS.fields.apellido,
    section: { domicilio: null, sucursal: 'recipient' },
    required: { domicilio: false, sucursal: false },
    modalities: SUCURSAL_ONLY,
    anchor: null,
  },
  {
    key: 'email',
    label: MESSAGE_LABELS.fields.email,
    section: { domicilio: null, sucursal: 'recipient' },
    required: { domicilio: false, sucursal: false },
    modalities: SUCURSAL_ONLY,
    anchor: null,
  },
  {
    key: 'telefono',
    label: MESSAGE_LABELS.fields.telefono,
    section: { domicilio: null, sucursal: 'recipient' },
    required: { domicilio: false, sucursal: false },
    modalities: SUCURSAL_ONLY,
    anchor: null,
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

function compareFields(a: MessageFieldKey | 'section', b: MessageFieldKey | 'section'): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** One raw `Label: value` line, before modality- and section-aware validation. */
interface ParsedField {
  value: string;
  /** The label as written (markers stripped), for issue messages. */
  label: string;
  /** The section the line appeared under; null = before any known heading. */
  section: MessageSectionKey | null;
  spec: FieldSpec;
  /** Set when an earlier validation pass already reported and dropped this line. */
  dropped?: boolean;
}

interface FieldIssueTarget {
  key: MessageFieldKey;
  label: string;
  anchor: PanelAnchor | null;
}

function invalidField(target: FieldIssueTarget, value: string, reason: string): InvalidField {
  return {
    field: target.key,
    ...(target.anchor === null ? {} : { anchor: target.anchor }),
    label: target.label,
    value,
    reason,
  };
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
  const missing: MissingField[] = [];
  const invalid: InvalidField[] = [];
  const unknownLabels: string[] = [];
  const seenSections = new Set<MessageSectionKey>();
  const entries: ParsedField[] = [];
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

    // Section membership, wrong-format labels and duplicates are all validated
    // later, once the modality is known: the expected section (and the required
    // set) depend on the format version, and the old parser reported a
    // wrong-section line before a duplicate one, so the order is preserved.
    entries.push({ value, label, section: currentSection, spec });
  }

  // ---------------------------------------------------------------- modality
  //
  // Format-version rule, not an inference: absence of the `Modalidad` line
  // means the old format, which only ever carried domicilio. When present, the
  // value must be exactly `domicilio` or `sucursal` (accent/case-insensitive).
  let modality: MessageModality = 'domicilio';
  const modalidadEntry = entries.find((entry) => entry.spec.key === 'modalidad');
  if (modalidadEntry !== undefined) {
    const key = normalizeLookupKey(modalidadEntry.value);
    if (key === MODALITY_VALUES.domicilio) {
      modality = 'domicilio';
    } else if (key === MODALITY_VALUES.sucursal) {
      modality = 'sucursal';
    } else {
      invalid.push(
        invalidField(
          issueTarget(invariant(SPEC_BY_KEY.get('modalidad'), 'modalidad spec')),
          modalidadEntry.value,
          `"${modalidadEntry.value}" is not a valid "Modalidad": the format only accepts "domicilio" or "sucursal"`,
        ),
      );
      // Without a known modality nothing else can be validated against a
      // format; report what was collected and stop.
      return { ok: false, missing, invalid, unknownLabels };
    }
  }

  // Labels the declared format does not define are a rejection naming them —
  // wrong-format data must never be silently dropped (R12).
  for (const entry of entries) {
    if (entry.spec.key === 'modalidad') continue;
    if (entry.spec.modalities.includes(modality)) continue;
    const reason =
      modality === 'sucursal'
        ? `"${entry.spec.label}" belongs to the domicilio format: a sucursal message must not carry domicilio address data (wrong-format data is never silently dropped)`
        : `"${entry.spec.label}" belongs to the sucursal format: a domicilio message must not carry sucursal data (wrong-format data is never silently dropped)`;
    invalid.push(invalidField(issueTarget(entry.spec), entry.value, reason));
    entry.dropped = true;
  }

  // Section membership, per the declared modality's own layout.
  for (const entry of entries) {
    if (entry.dropped) continue;
    const expected = entry.spec.section[modality];
    if (expected === null) {
      if (entry.section !== null) {
        invalid.push(
          invalidField(
            issueTarget(entry.spec),
            entry.value,
            `"${entry.spec.label}" belongs at the top of the message (before any section heading), but appears under "${sectionLabel(entry.section)}"`,
          ),
        );
        entry.dropped = true;
      }
      continue;
    }
    if (entry.section === null) {
      invalid.push(
        invalidField(
          issueTarget(entry.spec),
          entry.value,
          `"${entry.label}" appears before any known section heading`,
        ),
      );
      entry.dropped = true;
      continue;
    }
    if (entry.section !== expected) {
      invalid.push(
        invalidField(
          issueTarget(entry.spec),
          entry.value,
          `"${entry.spec.label}" belongs to section "${sectionLabel(expected)}" but appears under "${sectionLabel(entry.section)}"`,
        ),
      );
      entry.dropped = true;
    }
  }

  // Duplicates, last: only surviving entries count, so a line already dropped
  // by a section mismatch is reported as the mismatch it actually was.
  const parsed = new Map<MessageFieldKey, ParsedField>();
  for (const entry of entries) {
    if (entry.dropped) continue;
    if (parsed.has(entry.spec.key)) {
      invalid.push(
        invalidField(
          issueTarget(entry.spec),
          entry.value,
          `duplicate "${entry.spec.label}": it already appeared earlier in the message`,
        ),
      );
      continue;
    }
    parsed.set(entry.spec.key, entry);
  }

  // Missing required fields: absent line, or present with an empty value.
  for (const spec of FIELD_SPECS) {
    if (!spec.modalities.includes(modality) || !spec.required[modality]) continue;
    const entry = parsed.get(spec.key);
    if (entry === undefined || entry.value === '') {
      parsed.delete(spec.key);
      const issueTargetForMissing = issueTarget(spec);
      missing.push({
        field: spec.key,
        ...(issueTargetForMissing.anchor === null ? {} : { anchor: issueTargetForMissing.anchor as PanelAnchor }),
        label: spec.label,
      });
    }
  }
  missing.sort((a, b) => compareFields(a.field, b.field));

  // Value validation runs even when fields are missing, so the rejection names
  // every category at once (never short-circuited).
  if (modality === 'sucursal') {
    return sucursalRequest(parsed, config, missing, invalid, unknownLabels);
  }
  return domicilioRequest(parsed, config, missing, invalid, unknownLabels);
}

/** Validates the domicilio values, then builds the request or the full rejection. */
function domicilioRequest(
  parsed: Map<MessageFieldKey, ParsedField>,
  config: ProjectConfig,
  missing: MissingField[],
  invalid: InvalidField[],
  unknownLabels: string[],
): ParseResult {
  const valueOf = (key: MessageFieldKey): string | undefined => parsed.get(key)?.value;

  // Field-level validation of everything that was present.
  let province: ProvinceOption | undefined;
  const rawProvince = valueOf('province');
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
  const rawZipCode = valueOf('zipCode');
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
  const rawFullName = valueOf('fullName');
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

  const city = valueOf('city');
  const street = valueOf('address');
  const number = valueOf('number');
  const complement = valueOf('complement');

  if (missing.length > 0 || invalid.length > 0 || unknownLabels.length > 0) {
    return { ok: false, missing, invalid, unknownLabels };
  }

  // Barrio is real parsed input. It is derived from Ciudad only when the message
  // omits it; a differing pair is reported as a warning, never rejected.
  const rawNeighborhood = valueOf('neighborhood');
  const parsedNeighborhood =
    rawNeighborhood === undefined || rawNeighborhood === '' ? null : rawNeighborhood;

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
    modality: 'domicilio',
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

/** Validates the sucursal values, then builds the request or the full rejection. */
function sucursalRequest(
  parsed: Map<MessageFieldKey, ParsedField>,
  config: ProjectConfig,
  missing: MissingField[],
  invalid: InvalidField[],
  unknownLabels: string[],
): ParseResult {
  const valueOf = (key: MessageFieldKey): string | undefined => parsed.get(key)?.value;

  let zipCode: string | undefined;
  const rawZipCode = valueOf('zipCode');
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

  if (invalid.length > 0) return { ok: false, missing, invalid, unknownLabels };

  if (missing.length > 0 || invalid.length > 0 || unknownLabels.length > 0) {
    return { ok: false, missing, invalid, unknownLabels };
  }

  // Sucursal (nombre) is free text: trim + collapse whitespace only, no other
  // normalization. It is validated against the panel dropdown later.
  const sucursalName = valueOf('sucursal');
  const customerName = valueOf('nombre');
  const lastName = valueOf('apellido');
  const email = valueOf('email');
  const telefono = valueOf('telefono');

  const value: SucursalShipmentRequest = {
    modality: 'sucursal',
    zipCode: invariant(zipCode, 'zipCode resolved after validation'),
    sucursal: invariant(sucursalName, 'sucursal name resolved after validation'),
    customer: {
      name: invariant(customerName, 'customer name resolved after validation'),
      lastName: lastName === undefined || lastName === '' ? null : lastName,
      email: email === undefined || email === '' ? null : email,
      phone: telefono === undefined || telefono === '' ? null : telefono,
    },
    // Required-with-default: the declared value is prefilled from config and
    // shown editable in the preview, never applied silently.
    box: { ...config.package, declaredValueArs: config.sucursal.declaredValueArs },
    derived: [],
  };

  return { ok: true, value, warnings: [] };
}

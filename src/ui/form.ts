/**
 * The editable form model (plan §4b S3/S7, §6).
 *
 * The form is the payload: the operator sees every panel field with the value
 * that will be typed, may edit any of them, and exactly the values that are on
 * screen are what `runAttempt` writes to the panel. So this is a *data* model, not
 * markup: the page renders whatever `formFieldsFromRequest` returns, and every
 * run direction rebuilds a `ShipmentRequest` from the posted values with
 * `requestFromForm`.
 *
 * Two rules make the round trip honest:
 *
 * - The form is keyed by panel field, not by message label. `Barrio`, `Calle` and
 *   `Nombre completo` are message wording; `address.neighborhood`,
 *   `address.address` and `customer.name` + `customer.lastName` are panel fields.
 * - Nothing is defaulted here. A missing required value is an error with a
 *   reason; the only values that exist without the operator typing them are the
 *   package defaults the project declares (S7), which are shown in the form.
 *
 * `Provincia` is the panel's own `<select>`: the form carries the option *name*
 * and `resolveProvince` maps it back to the letter code the panel writes, so the
 * alias table (and its ambiguity refusal) is reused instead of duplicated.
 */
import type { PackageDefaults } from '../core/config';
import { POSTAL_CODE_HINT, isPostalCode, normalizePostalCode } from '../core/postal-code';
import { resolveProvince } from '../core/provinces';
import type { Derivation, PanelAnchor, ShipmentRequest } from '../core/types';

/** The editable fields, in the order the page shows them. */
export type FormKey =
  | 'zipCode'
  | 'province'
  | 'city'
  | 'address'
  | 'number'
  | 'complement'
  | 'neighborhood'
  | 'name'
  | 'lastName'
  | 'height'
  | 'width'
  | 'depth'
  | 'weight'
  | 'declaredValue';

/** How the page must render one field. */
export type FormKind = 'text' | 'province' | 'measure';

/**
 * The three groups the artboard draws, plus the optional declaration.
 *
 * Grouping is data, not markup: the page renders whatever groups the form model
 * declares, so a field can be moved between groups without touching `client.ts`.
 */
export type FormGroup = 'destino' | 'destinatario' | 'paquete' | 'declaracion';

/** The heading each group prints, in the order the page shows them. */
export const FORM_GROUP_LABELS: Readonly<Record<FormGroup, string>> = {
  destino: 'Destino',
  destinatario: 'Destinatario',
  paquete: 'Paquete · valores por defecto',
  declaracion: 'Monto declarado (opcional)',
};

interface FormSpec {
  key: FormKey;
  label: string;
  /** The panel control this value goes into, as observed in §4c. */
  panelField: string;
  /** Panel anchor, when the field maps 1:1 onto one (used to match derivations). */
  anchor: PanelAnchor | null;
  /** Unit shown next to the input. `''` for text fields. */
  unit: string;
  kind: FormKind;
  required: boolean;
  group: FormGroup;
  /** True when the field spans both columns of the grid. */
  wide: boolean;
  help: string;
}

/**
 * Order matters: it is the reading order of the preview, and it follows the
 * artboard (`04-mesa-con-rail.html`) field for field: the postal code, the
 * province, the city, the neighbourhood, the street, the number, then the
 * optional apartment.
 * `required` mirrors the panel where it is known (`Apellido` and `Departamento`
 * are marked optional there; `Barrio` carries no marker, so it is treated as
 * required — plan §4c).
 */
const FORM_SPECS: readonly FormSpec[] = [
  {
    key: 'zipCode',
    label: 'Código postal',
    panelField: 'zipCode',
    anchor: 'zipCode',
    unit: '',
    kind: 'text',
    required: true,
    group: 'destino',
    wide: false,
    help: '4 dígitos (1901) u 8 caracteres CPA (B1900ABC)',
  },
  {
    key: 'province',
    label: 'Provincia',
    panelField: 'address.province',
    anchor: 'address.province',
    unit: '',
    kind: 'province',
    required: true,
    group: 'destino',
    wide: false,
    help: 'se escribe por código y se relee por nombre',
  },
  {
    key: 'city',
    label: 'Ciudad',
    panelField: 'address.city',
    anchor: 'address.city',
    unit: '',
    kind: 'text',
    required: true,
    group: 'destino',
    wide: false,
    help: 'texto libre en el panel',
  },
  {
    key: 'neighborhood',
    label: 'Barrio',
    panelField: 'address.neighborhood',
    anchor: 'address.neighborhood',
    unit: '',
    kind: 'text',
    required: true,
    group: 'destino',
    wide: false,
    help: 'el panel no lo marca opcional',
  },
  {
    key: 'address',
    label: 'Calle',
    panelField: 'address.address',
    anchor: 'address.address',
    unit: '',
    kind: 'text',
    required: true,
    group: 'destino',
    wide: false,
    help: '',
  },
  {
    key: 'number',
    label: 'Número',
    panelField: 'address.number',
    anchor: 'address.number',
    unit: '',
    kind: 'text',
    required: true,
    group: 'destino',
    wide: false,
    help: 'campo separado de la calle',
  },
  {
    key: 'complement',
    label: 'Departamento',
    panelField: 'address.complement',
    anchor: 'address.complement',
    unit: '',
    kind: 'text',
    required: false,
    group: 'destino',
    wide: true,
    help: 'opcional en el panel',
  },
  {
    key: 'name',
    label: 'Nombre',
    panelField: 'customer.name',
    anchor: 'customer.name',
    unit: '',
    kind: 'text',
    required: true,
    group: 'destinatario',
    wide: false,
    help: '',
  },
  {
    key: 'lastName',
    label: 'Apellido',
    panelField: 'customer.lastName',
    anchor: 'customer.lastName',
    unit: '',
    kind: 'text',
    required: false,
    group: 'destinatario',
    wide: false,
    help: 'opcional en el panel',
  },
  {
    key: 'height',
    label: 'Alto',
    panelField: 'box.height',
    anchor: null,
    unit: 'cm',
    kind: 'measure',
    required: true,
    group: 'paquete',
    wide: false,
    help: 'valor declarado por el proyecto (S7)',
  },
  {
    key: 'width',
    label: 'Ancho',
    panelField: 'box.width',
    anchor: null,
    unit: 'cm',
    kind: 'measure',
    required: true,
    group: 'paquete',
    wide: false,
    help: 'valor declarado por el proyecto (S7)',
  },
  {
    key: 'depth',
    label: 'Profundidad',
    panelField: 'box.depth',
    anchor: null,
    unit: 'cm',
    kind: 'measure',
    required: true,
    group: 'paquete',
    wide: false,
    help: 'valor declarado por el proyecto (S7)',
  },
  {
    key: 'weight',
    label: 'Peso',
    panelField: 'box.weight',
    anchor: null,
    unit: 'g',
    kind: 'measure',
    required: true,
    group: 'paquete',
    wide: false,
    help: 'el panel lee gramos, no kilos',
  },
  {
    key: 'declaredValue',
    label: 'Monto declarado',
    panelField: 'declaredValue',
    anchor: null,
    unit: '$',
    kind: 'measure',
    required: false,
    group: 'declaracion',
    wide: true,
    help: 'opcional en el panel',
  },
];

/** One row of the form, as the page receives it. */
export interface FormField {
  key: FormKey;
  label: string;
  panelField: string;
  unit: string;
  kind: FormKind;
  required: boolean;
  /** Which group heading the field is rendered under. */
  group: FormGroup;
  /** The heading text of `group`, so the page never holds its own copy. */
  groupLabel: string;
  /** True when the field spans the whole grid width. */
  wide: boolean;
  help: string;
  value: string;
  /** Non-empty when the value was computed rather than parsed (R12). */
  derived: Derivation[];
}

/** Values posted back from the page: field key → raw text. */
export type FormValues = Readonly<Record<string, unknown>>;

export interface FormIssue {
  field: FormKey | '*';
  message: string;
}

export type FormBuildResult =
  | { ok: true; value: ShipmentRequest; values: Record<FormKey, string> }
  | { ok: false; errors: FormIssue[] };

const SPEC_BY_KEY = new Map<FormKey, FormSpec>(FORM_SPECS.map((spec) => [spec.key, spec]));

function specOf(key: FormKey): FormSpec {
  const spec = SPEC_BY_KEY.get(key);
  if (spec === undefined) throw new Error(`form invariant violated: no spec for "${key}"`);
  return spec;
}

/** The form field that holds a panel anchor, when there is one. */
export function formKeyForAnchor(anchor: PanelAnchor | null): FormKey | null {
  if (anchor === null) return null;
  const spec = FORM_SPECS.find((candidate) => candidate.anchor === anchor);
  return spec === undefined ? null : spec.key;
}

function derivationAnchorField(derivation: Derivation): FormKey | null {
  return formKeyForAnchor(derivation.anchor);
}

function text(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

/** Prefills the editable form from the parsed request (S3, S7). */
export function formFieldsFromRequest(request: ShipmentRequest): FormField[] {
  const values: Record<FormKey, string> = {
    zipCode: request.zipCode,
    province: request.address.province.name,
    city: request.address.city,
    address: request.address.address,
    number: request.address.number,
    complement: request.address.complement ?? '',
    neighborhood: request.address.neighborhood,
    name: request.customer.name,
    lastName: request.customer.lastName ?? '',
    height: text(request.box.heightCm),
    width: text(request.box.widthCm),
    depth: text(request.box.depthCm),
    weight: text(request.box.weightG),
    declaredValue: text(request.box.declaredValueArs),
  };

  return FORM_SPECS.map((spec) => ({
    key: spec.key,
    label: spec.label,
    panelField: spec.panelField,
    unit: spec.unit,
    kind: spec.kind,
    required: spec.required,
    group: spec.group,
    groupLabel: FORM_GROUP_LABELS[spec.group],
    wide: spec.wide,
    help: spec.help,
    value: values[spec.key],
    derived: request.derived.filter((derivation) => derivationAnchorField(derivation) === spec.key),
  }));
}

/** The raw values of a rendered form, so a page can post them back unchanged. */
export function formValuesFromFields(fields: readonly FormField[]): Record<FormKey, string> {
  const values = {} as Record<FormKey, string>;
  for (const field of fields) values[field.key] = field.value;
  return values;
}

/** Reads one posted value without trusting its JSON type. */
function readValue(values: FormValues, key: FormKey): string {
  const raw = values[key];
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return '';
}

/** Collapses internal whitespace, exactly as the parser does for text fields. */
function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

const MEASURE_PATTERN = /^\d+(?:\.\d+)?$/;

/**
 * Rebuilds the request from the posted form values.
 *
 * This is the only place edited values become a payload, and every rule here is
 * a refusal, never a default: a blank required field, an unknown province, an
 * unusable postal code or a non-positive measure rejects the whole form with
 * every issue named at once.
 */
export function requestFromForm(values: FormValues): FormBuildResult {
  const errors: FormIssue[] = [];

  const textField = (key: FormKey): string => {
    const value = collapse(readValue(values, key));
    if (value === '' && specOf(key).required) {
      errors.push({ field: key, message: `«${specOf(key).label}» es obligatorio` });
    }
    return value;
  };

  const zipCode = normalizePostalCode(textField('zipCode'));
  if (zipCode !== '' && !isPostalCode(zipCode)) {
    errors.push({
      field: 'zipCode',
      message: `código postal «${zipCode}» no es válido: ${POSTAL_CODE_HINT}`,
    });
  }

  const provinceText = textField('province');
  const province = provinceText === '' ? null : resolveProvince(provinceText);
  if (province !== null && !province.ok) {
    errors.push({ field: 'province', message: province.reason });
  }

  const city = textField('city');
  const street = textField('address');
  const streetNumber = textField('number');
  const complement = textField('complement');
  const neighborhood = textField('neighborhood');
  const name = textField('name');
  const lastName = textField('lastName');

  const measure = (key: FormKey): number | null => {
    const spec = specOf(key);
    const raw = collapse(readValue(values, key));
    if (raw === '') {
      if (spec.required) {
        errors.push({ field: key, message: `«${spec.label}» es obligatorio (en ${spec.unit})` });
      }
      return null;
    }
    if (!MEASURE_PATTERN.test(raw) || Number(raw) <= 0) {
      errors.push({
        field: key,
        message: `«${spec.label}» debe ser un número positivo en ${spec.unit} (recibido «${raw}»)`,
      });
      return null;
    }
    return Number(raw);
  };

  const heightCm = measure('height');
  const widthCm = measure('width');
  const depthCm = measure('depth');
  const weightG = measure('weight');

  const declaredRaw = collapse(readValue(values, 'declaredValue'));
  let declaredValueArs: number | undefined;
  if (declaredRaw !== '') {
    if (!MEASURE_PATTERN.test(declaredRaw)) {
      errors.push({
        field: 'declaredValue',
        message: `«Monto total abonado» debe ser un número en $ (recibido «${declaredRaw}»)`,
      });
    } else {
      declaredValueArs = Number(declaredRaw);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  if (province === null || !province.ok) {
    // Unreachable: a blank province already produced an error above.
    return { ok: false, errors: [{ field: 'province', message: '«Provincia» es obligatoria' }] };
  }
  if (
    heightCm === null ||
    widthCm === null ||
    depthCm === null ||
    weightG === null
  ) {
    return {
      ok: false,
      errors: [{ field: '*', message: 'las medidas del paquete son obligatorias' }],
    };
  }

  const box: PackageDefaults = { heightCm, widthCm, depthCm, weightG };
  if (declaredValueArs !== undefined) box.declaredValueArs = declaredValueArs;

  const value: ShipmentRequest = {
    zipCode,
    address: {
      province: { code: province.value.code, name: province.value.name },
      city,
      address: street,
      number: streetNumber,
      complement: complement === '' ? null : complement,
      neighborhood,
    },
    customer: { name, lastName: lastName === '' ? null : lastName },
    box,
    /**
     * Nothing is derived any more: every value here was on screen and editable.
     * Derivations are a property of the *parse*, not of the approved payload.
     */
    derived: [],
  };

  return { ok: true, value, values: formValuesFromFields(formFieldsFromRequest(value)) };
}

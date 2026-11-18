/**
 * The editable form model (plan §4b S3/S7, §6).
 *
 * The form is the payload: the operator sees every panel field with the value
 * that will be typed, may edit any of them, and exactly the values that are on
 * screen are what `runAttempt` writes to the panel. So this is a *data* model, not
 * markup: the page renders whatever `formFieldsFromRequest` returns, and every
 * run direction rebuilds a request from the posted values with `requestFromForm`.
 *
 * Two rules make the round trip honest:
 *
 * - The form is keyed by panel field, not by message label. `Barrio`, `Calle` and
 *   `Nombre completo` are message wording; `address.neighborhood`,
 *   `address.address` and `customer.name` + `customer.lastName` are panel fields.
 * - Nothing is defaulted here. A missing required value is an error with a
 *   reason; the only values that exist without the operator typing them are the
 *   package defaults the project declares (S7) and — for sucursal only — the
 *   declared value (required-with-default), which is prefilled and shown
 *   editable, never applied silently.
 *
 * `Provincia` is the panel's own `<select>`: the form carries the option *name*
 * and `resolveProvince` maps it back to the letter code the panel writes, so the
 * alias table (and its ambiguity refusal) is reused instead of duplicated.
 *
 * The form is **modality-aware**: `Modalidad` is the first field (a segmented
 * control on the page) and switching it re-derives the visible field set —
 * domicilio shows the address group, sucursal shows `Sucursal` + postal code and
 * hides the address group. `formFieldsForBothModalities` hands the page both
 * sets so the switch needs no new server round trip.
 */
import { DEFAULT_CONFIG, type PackageDefaults, type ProjectConfig } from '../core/config';
import { POSTAL_CODE_HINT, isPostalCode, normalizePostalCode } from '../core/postal-code';
import { resolveProvince } from '../core/provinces';
import type {
  AnyShipmentRequest,
  Derivation,
  MessageModality,
  PanelAnchor,
  ShipmentRequest,
  SucursalShipmentRequest,
} from '../core/types';

/** The editable fields, in the order the page shows them. */
export type FormKey =
  | 'modalidad'
  | 'zipCode'
  | 'province'
  | 'city'
  | 'address'
  | 'number'
  | 'complement'
  | 'neighborhood'
  | 'sucursal'
  | 'name'
  | 'lastName'
  | 'email'
  | 'telefono'
  | 'height'
  | 'width'
  | 'depth'
  | 'weight'
  | 'declaredValue';

/** How the page must render one field. */
export type FormKind = 'text' | 'province' | 'measure' | 'modalidad';

/**
 * The groups the artboard draws, plus the optional declaration.
 *
 * Grouping is data, not markup: the page renders whatever groups the form model
 * declares, so a field can be moved between groups without touching `client.ts`.
 */
export type FormGroup = 'modalidad' | 'destino' | 'destinatario' | 'paquete' | 'declaracion';

/** The heading each group prints, in the order the page shows them. */
export const FORM_GROUP_LABELS: Readonly<Record<FormGroup, string>> = {
  modalidad: 'Modalidad de envío',
  destino: 'Destino',
  destinatario: 'Destinatario',
  paquete: 'Paquete · valores por defecto',
  declaracion: 'Monto declarado (opcional)',
};

/**
 * Placeholder for the sucursal field's panel anchor: the real anchors for the
 * sucursal dropdown are decided by the executor slice, after a DOM discovery
 * pass. The form never claims an anchor it has not observed.
 */
export const SUCURSAL_ANCHOR_PENDING = '(pendiente de descubrir en el panel)';

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
  /** Whether the field is required, per modality. */
  requiredByModality: Record<MessageModality, boolean>;
  /** The modalities whose form carries this field at all. */
  modalities: readonly MessageModality[];
  group: FormGroup;
  /** True when the field spans both columns of the grid. */
  wide: boolean;
  help: string;
}

const BOTH_MODALITIES: readonly MessageModality[] = ['domicilio', 'sucursal'];
const DOMICILIO_ONLY: readonly MessageModality[] = ['domicilio'];
const SUCURSAL_ONLY: readonly MessageModality[] = ['sucursal'];

/**
 * Order matters: it is the reading order of the preview, and it follows the
 * artboard (`04-mesa-con-rail.html`) field for field. `Modalidad` comes first:
 * switching it re-derives which of the two lists below is on screen.
 */
const FORM_SPECS: readonly FormSpec[] = [
  {
    key: 'modalidad',
    label: 'Modalidad',
    panelField: '(decisión de formato: domicilio | sucursal)',
    anchor: null,
    unit: '',
    kind: 'modalidad',
    requiredByModality: { domicilio: true, sucursal: true },
    modalities: BOTH_MODALITIES,
    group: 'modalidad',
    wide: true,
    help: 'define qué campos se muestran; los mensajes viejos sin Modalidad son domicilio',
  },
  {
    key: 'zipCode',
    label: 'Código postal',
    panelField: 'zipCode',
    anchor: 'zipCode',
    unit: '',
    kind: 'text',
    requiredByModality: { domicilio: true, sucursal: true },
    modalities: BOTH_MODALITIES,
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
    requiredByModality: { domicilio: true, sucursal: false },
    modalities: DOMICILIO_ONLY,
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
    requiredByModality: { domicilio: true, sucursal: false },
    modalities: DOMICILIO_ONLY,
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
    requiredByModality: { domicilio: true, sucursal: false },
    modalities: DOMICILIO_ONLY,
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
    requiredByModality: { domicilio: true, sucursal: false },
    modalities: DOMICILIO_ONLY,
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
    requiredByModality: { domicilio: true, sucursal: false },
    modalities: DOMICILIO_ONLY,
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
    requiredByModality: { domicilio: false, sucursal: false },
    modalities: DOMICILIO_ONLY,
    group: 'destino',
    wide: true,
    help: 'opcional en el panel',
  },
  {
    key: 'sucursal',
    label: 'Sucursal',
    panelField: SUCURSAL_ANCHOR_PENDING,
    anchor: null,
    unit: '',
    kind: 'text',
    requiredByModality: { domicilio: false, sucursal: true },
    modalities: SUCURSAL_ONLY,
    group: 'destino',
    wide: true,
    help: 'texto libre; se valida contra el dropdown del panel en una etapa posterior',
  },
  {
    key: 'name',
    label: 'Nombre',
    panelField: 'customer.name',
    anchor: 'customer.name',
    unit: '',
    kind: 'text',
    requiredByModality: { domicilio: true, sucursal: true },
    modalities: BOTH_MODALITIES,
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
    requiredByModality: { domicilio: false, sucursal: false },
    modalities: BOTH_MODALITIES,
    group: 'destinatario',
    wide: false,
    help: 'opcional en el panel',
  },
  {
    key: 'email',
    label: 'Email',
    panelField: 'customer.email',
    anchor: null,
    unit: '',
    kind: 'text',
    requiredByModality: { domicilio: false, sucursal: false },
    modalities: SUCURSAL_ONLY,
    group: 'destinatario',
    wide: false,
    help: 'opcional en el panel',
  },
  {
    key: 'telefono',
    label: 'Teléfono',
    panelField: 'customer.phoneNumber',
    anchor: null,
    unit: '',
    kind: 'text',
    requiredByModality: { domicilio: false, sucursal: false },
    modalities: SUCURSAL_ONLY,
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
    requiredByModality: { domicilio: true, sucursal: true },
    modalities: BOTH_MODALITIES,
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
    requiredByModality: { domicilio: true, sucursal: true },
    modalities: BOTH_MODALITIES,
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
    requiredByModality: { domicilio: true, sucursal: true },
    modalities: BOTH_MODALITIES,
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
    requiredByModality: { domicilio: true, sucursal: true },
    modalities: BOTH_MODALITIES,
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
    requiredByModality: { domicilio: false, sucursal: true },
    modalities: BOTH_MODALITIES,
    group: 'declaracion',
    wide: true,
    help: 'opcional en el panel para domicilio; para sucursal lo prellena el valor del proyecto y se muestra editable',
  },
];

/** The reading order of the domicilio form. */
const DOMICILIO_FIELD_ORDER: readonly FormKey[] = [
  'modalidad',
  'zipCode',
  'province',
  'city',
  'neighborhood',
  'address',
  'number',
  'complement',
  'name',
  'lastName',
  'height',
  'width',
  'depth',
  'weight',
  'declaredValue',
];

/** The reading order of the sucursal form: no address group, sucursal + CP instead. */
const SUCURSAL_FIELD_ORDER: readonly FormKey[] = [
  'modalidad',
  'zipCode',
  'sucursal',
  'name',
  'lastName',
  'email',
  'telefono',
  'height',
  'width',
  'depth',
  'weight',
  'declaredValue',
];

const FIELD_ORDER: Readonly<Record<MessageModality, readonly FormKey[]>> = {
  domicilio: DOMICILIO_FIELD_ORDER,
  sucursal: SUCURSAL_FIELD_ORDER,
};

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
  | { ok: true; value: AnyShipmentRequest; values: Record<FormKey, string> }
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

/** The raw text values of one modality's form, prefilled from a parsed request. */
function valuesForModalidad(
  modality: MessageModality,
  request: AnyShipmentRequest,
  config: ProjectConfig,
): Record<FormKey, string> {
  const box = request.box;
  if (modality === 'sucursal') {
    const sucursal = request.modality === 'sucursal' ? request : null;
    return {
      modalidad: 'sucursal',
      zipCode: request.zipCode,
      province: '',
      city: '',
      address: '',
      number: '',
      complement: '',
      neighborhood: '',
      // Never invented: a domicilio parse carries no sucursal data, so the
      // operator fills it; only the config's own default is prefilled.
      sucursal: sucursal?.sucursal ?? '',
      name: request.customer.name,
      lastName: request.customer.lastName ?? '',
      email: sucursal?.customer.email ?? '',
      telefono: sucursal?.customer.phone ?? '',
      height: text(box.heightCm),
      width: text(box.widthCm),
      depth: text(box.depthCm),
      weight: text(box.weightG),
      // Required-with-default for sucursal: prefilled from config, visible and
      // editable in the preview, never silent.
      declaredValue: text(config.sucursal.declaredValueArs),
    };
  }
  const domicilio = request.modality === 'domicilio' ? request : null;
  return {
    modalidad: 'domicilio',
    zipCode: request.zipCode,
    province: domicilio?.address.province.name ?? '',
    city: domicilio?.address.city ?? '',
    address: domicilio?.address.address ?? '',
    number: domicilio?.address.number ?? '',
    complement: domicilio?.address.complement ?? '',
    neighborhood: domicilio?.address.neighborhood ?? '',
    sucursal: '',
    name: request.customer.name,
    lastName: request.customer.lastName ?? '',
    email: '',
    telefono: '',
    height: text(box.heightCm),
    width: text(box.widthCm),
    depth: text(box.depthCm),
    weight: text(box.weightG),
    // Domicilio keeps its optional, empty declared value.
    declaredValue: domicilio ? text(domicilio.box.declaredValueArs) : '',
  };
}

function fieldsForModalidad(
  modality: MessageModality,
  values: Record<FormKey, string>,
  derivations: readonly Derivation[],
): FormField[] {
  return FIELD_ORDER[modality].map((key) => {
    const spec = specOf(key);
    return {
      key: spec.key,
      label: spec.label,
      panelField: spec.panelField,
      unit: spec.unit,
      kind: spec.kind,
      required: spec.requiredByModality[modality],
      group: spec.group,
      groupLabel: FORM_GROUP_LABELS[spec.group],
      wide: spec.wide,
      help: spec.help,
      value: values[spec.key],
      derived: derivations.filter((derivation) => derivationAnchorField(derivation) === spec.key),
    };
  });
}

/** Prefills the editable form from the parsed request, for its modality (S3, S7). */
export function formFieldsFromRequest(request: AnyShipmentRequest): FormField[] {
  return fieldsForModalidad(request.modality, valuesForModalidad(request.modality, request, DEFAULT_CONFIG), request.derived);
}

/**
 * Both modality forms, prefilled from one parsed request.
 *
 * The page holds both lists so switching the `Modalidad` control re-derives the
 * visible field set without a new parse. Only data that genuinely exists is
 * prefilled: a domicilio parse carries no sucursal data (the sucursal field
 * stays empty for the operator), and a sucursal parse carries no domicilio
 * address data (the address group stays empty). The declared value takes the
 * declared policy of each modality: optional and empty for domicilio, the
 * project's required-with-default for sucursal.
 */
export function formFieldsForBothModalities(
  request: AnyShipmentRequest,
  config: ProjectConfig = DEFAULT_CONFIG,
): Record<MessageModality, FormField[]> {
  const domicilioValues = valuesForModalidad('domicilio', request, config);
  const sucursalValues = valuesForModalidad('sucursal', request, config);
  return {
    domicilio: fieldsForModalidad('domicilio', domicilioValues, request.modality === 'domicilio' ? request.derived : []),
    sucursal: fieldsForModalidad('sucursal', sucursalValues, request.modality === 'sucursal' ? request.derived : []),
  };
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
 *
 * The modality decides which required set applies. A posted form without a
 * readable `Modalidad` is treated as the old format (domicilio) — the same
 * format-version rule the parser applies to the message itself.
 */
export function requestFromForm(values: FormValues): FormBuildResult {
  const modalidad = collapse(readValue(values, 'modalidad'));
  if (modalidad === 'sucursal') return sucursalRequestFromForm(values);
  if (modalidad === '' || modalidad === 'domicilio') return domicilioRequestFromForm(values);
  return {
    ok: false,
    errors: [
      {
        field: 'modalidad',
        message: `«Modalidad» debe ser «domicilio» o «sucursal» (recibido «${modalidad}»)`,
      },
    ],
  };
}

function domicilioRequestFromForm(values: FormValues): FormBuildResult {
  const errors: FormIssue[] = [];
  const requiredOf = (key: FormKey): boolean => specOf(key).requiredByModality['domicilio'];

  const textField = (key: FormKey): string => {
    const value = collapse(readValue(values, key));
    if (value === '' && requiredOf(key)) {
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
      if (requiredOf(key)) {
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
    modality: 'domicilio',
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

function sucursalRequestFromForm(values: FormValues): FormBuildResult {
  const errors: FormIssue[] = [];
  const requiredOf = (key: FormKey): boolean => specOf(key).requiredByModality['sucursal'];

  const textField = (key: FormKey): string => {
    const value = collapse(readValue(values, key));
    if (value === '' && requiredOf(key)) {
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

  // Free text, like the parser: trim + collapse whitespace, nothing else.
  const sucursal = textField('sucursal');
  const name = textField('name');
  const lastName = textField('lastName');
  const email = textField('email');
  const telefono = textField('telefono');

  const measure = (key: FormKey): number | null => {
    const spec = specOf(key);
    const raw = collapse(readValue(values, key));
    if (raw === '') {
      if (requiredOf(key)) {
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

  // Required-with-default for sucursal: the form prefills it and shows it
  // editable; a cleared value is a refusal, never a silent omission.
  const declaredRaw = collapse(readValue(values, 'declaredValue'));
  let declaredValueArs: number | null = null;
  if (declaredRaw === '') {
    errors.push({
      field: 'declaredValue',
      message: '«Monto declarado» es obligatorio para sucursal: viene prellenado con el valor del proyecto',
    });
  } else if (!MEASURE_PATTERN.test(declaredRaw)) {
    errors.push({
      field: 'declaredValue',
      message: `«Monto declarado» debe ser un número en $ (recibido «${declaredRaw}»)`,
    });
  } else {
    declaredValueArs = Number(declaredRaw);
  }

  if (errors.length > 0) return { ok: false, errors };
  if (
    heightCm === null ||
    widthCm === null ||
    depthCm === null ||
    weightG === null ||
    declaredValueArs === null
  ) {
    return {
      ok: false,
      errors: [{ field: '*', message: 'las medidas del paquete son obligatorias' }],
    };
  }

  const value: SucursalShipmentRequest = {
    modality: 'sucursal',
    zipCode,
    sucursal,
    customer: {
      name,
      lastName: lastName === '' ? null : lastName,
      email: email === '' ? null : email,
      phone: telefono === '' ? null : telefono,
    },
    box: { heightCm, widthCm, depthCm, weightG, declaredValueArs: declaredValueArs },
    derived: [],
  };

  return { ok: true, value, values: formValuesFromFields(formFieldsFromRequest(value)) };
}

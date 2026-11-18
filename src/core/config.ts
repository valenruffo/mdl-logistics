/**
 * Project-declared package defaults (plan §4b, S7).
 *
 * Units are explicit in the field names because the panel mixes them: screen 1
 * shows dimensions in `cm` but weight in `g` (plan §4c). A 500 g package written
 * as `weightKg: 0.5` or as `weightG: 500000` is the failure mode this naming
 * exists to prevent.
 */

/** Panel screen 1 values: dimensions in centimetres, weight in grams. */
export interface PackageDefaults {
  /** Panel `box.height`, unit cm. */
  heightCm: number;
  /** Panel `box.width`, unit cm. */
  widthCm: number;
  /** Panel `box.depth`, unit cm. */
  depthCm: number;
  /** Panel `box.weight`, unit **grams** (the panel shows `g`, not kg). */
  weightG: number;
  /** Panel `declaredValue` ("Monto total abonado", optional), in ARS. */
  declaredValueArs?: number;
}

/** Validated project configuration. */
export interface ProjectConfig {
  /** Box defaults shared by both modalities: dimensions in cm, weight in g. */
  package: PackageDefaults;
  /**
   * Sucursal-only declared policy. The declared value is **required-with-default**
   * for sucursal: it is prefilled from here and shown editable in the preview
   * (never silently applied without being visible). Domicilio keeps its optional,
   * empty declared value (`package.declaredValueArs`).
   */
  sucursal: {
    /** The standing declared amount, in ARS. */
    declaredValueArs: number;
  };
}

/** Raised when the declared configuration cannot be used to fill the panel. */
export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid project configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

const MEASURE_NAMES = ['heightCm', 'widthCm', 'depthCm', 'weightG'] as const;

type MeasureName = (typeof MEASURE_NAMES)[number];

const MEASURE_UNITS: Record<MeasureName, string> = {
  heightCm: 'cm',
  widthCm: 'cm',
  depthCm: 'cm',
  weightG: 'g',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPositiveMeasure(
  source: Record<string, unknown> | null,
  name: MeasureName,
  issues: string[],
): number | undefined {
  const raw = source?.[name];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    issues.push(
      `package.${name} must be a positive finite number in ${MEASURE_UNITS[name]} (received ${JSON.stringify(raw) ?? 'undefined'})`,
    );
    return undefined;
  }
  return raw;
}

/**
 * Validates a candidate configuration and returns a fresh, normalized copy.
 * Collects every issue instead of throwing on the first one.
 *
 * Extra keys are dropped: a typo such as `weightKg` must not travel silently
 * into the payload.
 */
export function validateConfig(candidate: unknown): ProjectConfig {
  const issues: string[] = [];
  const root = isRecord(candidate) ? candidate : null;

  if (root === null) {
    throw new ConfigError(['configuration must be an object with a "package" block']);
  }

  const rawPackage = root['package'];
  const packageSource = isRecord(rawPackage) ? rawPackage : null;
  if (packageSource === null) {
    issues.push('package must be an object with heightCm, widthCm, depthCm and weightG');
  }

  const measures = MEASURE_NAMES.map((name) => readPositiveMeasure(packageSource, name, issues));

  let declaredValueArs: number | undefined;
  const rawDeclaredValue = packageSource?.['declaredValueArs'];
  if (rawDeclaredValue !== undefined) {
    if (typeof rawDeclaredValue !== 'number' || !Number.isFinite(rawDeclaredValue) || rawDeclaredValue < 0) {
      issues.push(
        `package.declaredValueArs must be a non-negative finite amount in ARS when present (received ${JSON.stringify(rawDeclaredValue) ?? 'undefined'})`,
      );
    } else {
      declaredValueArs = rawDeclaredValue;
    }
  }

  if (issues.length > 0) throw new ConfigError(issues);

  // Sucursal's declared value is required-with-default: a config without it is
  // an incomplete declaration, not one to fill with a silent fallback.
  const rawSucursal = root['sucursal'];
  const sucursalSource = isRecord(rawSucursal) ? rawSucursal : null;
  let sucursalDeclaredValueArs: number | undefined;
  if (sucursalSource === null) {
    issues.push('sucursal must be an object with declaredValueArs (the standing declared amount, in ARS)');
  } else {
    const rawSucursalDeclaredValue = sucursalSource['declaredValueArs'];
    if (
      typeof rawSucursalDeclaredValue !== 'number' ||
      !Number.isFinite(rawSucursalDeclaredValue) ||
      rawSucursalDeclaredValue < 0
    ) {
      issues.push(
        `sucursal.declaredValueArs must be a non-negative finite amount in ARS (received ${JSON.stringify(rawSucursalDeclaredValue) ?? 'undefined'})`,
      );
    } else {
      sucursalDeclaredValueArs = rawSucursalDeclaredValue;
    }
  }

  if (issues.length > 0) throw new ConfigError(issues);

  const [heightCm, widthCm, depthCm, weightG] = measures as [number, number, number, number];
  const packageDefaults: PackageDefaults = { heightCm, widthCm, depthCm, weightG };
  if (declaredValueArs !== undefined) packageDefaults.declaredValueArs = declaredValueArs;

  return {
    package: packageDefaults,
    sucursal: { declaredValueArs: sucursalDeclaredValueArs as number },
  };
}

/**
 * Defaults shipped with the project, validated at module load so a bad edit
 * fails immediately instead of producing a wrong shipment.
 *
 * Values are the operator's real standard package: 20 x 25 x 10 cm, 700 g.
 * The mapping between the three dimensions is cosmetic (the carrier bills the
 * volume); the weight is not — the panel reads it in **grams**, so `weightG`
 * stays 700 and the executor verifies the `g` unit button before writing.
 */
export const DEFAULT_CONFIG: ProjectConfig = validateConfig({
  package: { heightCm: 20, widthCm: 25, depthCm: 10, weightG: 700 },
  // The operator's standing declared value for sucursal shipments, in ARS.
  // Prefilled and shown editable in the preview; never applied silently.
  sucursal: { declaredValueArs: 100000 },
});

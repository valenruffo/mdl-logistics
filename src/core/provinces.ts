import { normalizeLookupKey, stripTrailingParenthetical } from './normalize';

/**
 * The panel's province `<select>` (plan §4c, "Provincia: the real option list").
 * 24 jurisdictions plus **Gran Buenos Aires (BX)**, which is a distinct option
 * from Buenos Aires (B) — that is precisely why `Bs As` cannot be mapped.
 */
export type ProvinceCode =
  | 'B'
  | 'K'
  | 'H'
  | 'U'
  | 'C'
  | 'BX'
  | 'X'
  | 'W'
  | 'E'
  | 'P'
  | 'Y'
  | 'L'
  | 'M'
  | 'N'
  | 'Q'
  | 'R'
  | 'A'
  | 'J'
  | 'D'
  | 'Z'
  | 'S'
  | 'G'
  | 'V'
  | 'T'
  | 'F';

/** One option of the panel select: `value` is the code, the text is the name. */
export interface ProvinceOption {
  readonly code: ProvinceCode;
  readonly name: string;
}

/** Panel option order, as observed in the real select. */
export const PROVINCE_OPTIONS: readonly ProvinceOption[] = [
  { code: 'B', name: 'Buenos Aires' },
  { code: 'K', name: 'Catamarca' },
  { code: 'H', name: 'Chaco' },
  { code: 'U', name: 'Chubut' },
  { code: 'C', name: 'Ciudad Autónoma de Buenos Aires' },
  { code: 'BX', name: 'Gran Buenos Aires' },
  { code: 'X', name: 'Córdoba' },
  { code: 'W', name: 'Corrientes' },
  { code: 'E', name: 'Entre Ríos' },
  { code: 'P', name: 'Formosa' },
  { code: 'Y', name: 'Jujuy' },
  { code: 'L', name: 'La Pampa' },
  { code: 'M', name: 'Mendoza' },
  { code: 'N', name: 'Misiones' },
  { code: 'Q', name: 'Neuquén' },
  { code: 'R', name: 'Río Negro' },
  { code: 'A', name: 'Salta' },
  { code: 'J', name: 'San Juan' },
  { code: 'D', name: 'San Luis' },
  { code: 'Z', name: 'Santa Cruz' },
  { code: 'S', name: 'Santa Fe' },
  { code: 'G', name: 'Santiago del Estero' },
  { code: 'V', name: 'Tierra del Fuego' },
  { code: 'T', name: 'Tucumán' },
  { code: 'F', name: 'La Rioja' },
];

const OPTION_BY_CODE = new Map<ProvinceCode, ProvinceOption>(
  PROVINCE_OPTIONS.map((option) => [option.code, option]),
);

const OPTION_BY_KEY = new Map<string, ProvinceOption>(
  PROVINCE_OPTIONS.map((option) => [normalizeLookupKey(option.name), option]),
);

/**
 * Additional accepted aliases. Only unambiguous ones: each alias names exactly
 * one of the panel options, so no wrong-province write is possible.
 */
const EXTRA_ALIASES: readonly { alias: string; code: ProvinceCode }[] = [
  { alias: 'CABA', code: 'C' },
  { alias: 'C.A.B.A.', code: 'C' },
  { alias: 'Capital Federal', code: 'C' },
];

for (const { alias, code } of EXTRA_ALIASES) {
  const option = OPTION_BY_CODE.get(code);
  if (option === undefined) throw new Error(`alias "${alias}" points at an unknown province code "${code}"`);
  OPTION_BY_KEY.set(normalizeLookupKey(alias), option);
}

/**
 * Abbreviations that name two different panel options. They are rejected with a
 * reason naming both, because picking one would be an invention (R12) and a
 * wrong-province shipment.
 */
const AMBIGUOUS_ALIASES: readonly string[] = ['Bs As', 'BsAs', 'B s As'];

function ambiguousPair(): readonly [ProvinceOption, ProvinceOption] {
  const buenosAires = OPTION_BY_CODE.get('B');
  const granBuenosAires = OPTION_BY_CODE.get('BX');
  if (buenosAires === undefined || granBuenosAires === undefined) {
    throw new Error('province option table is missing B or BX');
  }
  return [buenosAires, granBuenosAires];
}

const AMBIGUOUS_KEYS = new Map<string, readonly [ProvinceOption, ProvinceOption]>(
  AMBIGUOUS_ALIASES.map(
    (alias): [string, readonly [ProvinceOption, ProvinceOption]] => [
      normalizeLookupKey(alias),
      ambiguousPair(),
    ],
  ),
);

/** `Buenos Aires (B), Catamarca (K), …` — the operator-facing list of options. */
export function describeProvinceOptions(): string {
  return PROVINCE_OPTIONS.map((option) => `${option.name} (${option.code})`).join(', ');
}

function describeOption(option: ProvinceOption): string {
  return `${option.name} (${option.code})`;
}

/** Resolution outcome: the panel option to write, or the reason to reject. */
export type ProvinceResolution = { ok: true; value: ProvinceOption } | { ok: false; reason: string };

/**
 * Maps a message province to a panel option.
 *
 * - `Full name (ABBREV)` is accepted: the parenthetical is stripped first.
 * - Accents, case and stray whitespace are tolerated.
 * - Ambiguous abbreviations (`Bs As`) are rejected, never guessed.
 * - Anything unmatched is rejected with the full list of valid option names.
 */
export function resolveProvince(input: string): ProvinceResolution {
  const written = input.replace(/\s+/g, ' ').trim();
  const candidate = stripTrailingParenthetical(written) || written;
  const key = normalizeLookupKey(candidate);

  if (key === '') {
    return { ok: false, reason: `province is empty; valid options: ${describeProvinceOptions()}` };
  }

  const ambiguous = AMBIGUOUS_KEYS.get(key);
  if (ambiguous !== undefined) {
    return {
      ok: false,
      reason:
        `province "${written}" is ambiguous: "${written}" may mean ${describeOption(ambiguous[0])} ` +
        `or ${describeOption(ambiguous[1])}; write the full province name`,
    };
  }

  const option = OPTION_BY_KEY.get(key);
  if (option === undefined) {
    return {
      ok: false,
      reason: `unknown province "${written}"; valid options: ${describeProvinceOptions()}`,
    };
  }

  return { ok: true, value: option };
}

/**
 * The declared-value contract of the panel's currency-masked input.
 *
 * The `declaredValue` field on the sucursal screen (and the domicilio cost
 * screen) is a currency mask in the Argentine format: `$` prefix, `.` as the
 * thousand separator and `,` as the decimal mark — e.g. `$ 100.000,00` for
 * 100000 ARS. A programmatic write of the raw digits is reinterpreted by the
 * mask as a **cent amount** (`"100000"` → `$ 1.000,00`), which is the observed
 * live failure: the approved value never landed and `Continuar` never enabled.
 *
 * The executor therefore never compares this field as a string. Everything
 * reads back through `parseArsAmount` and compares numerically: the panel's
 * `$ 100.000,00` and the payload's `100000` are the same amount.
 */

/**
 * Parses a panel-formatted ARS amount into a number.
 *
 * Strips `$` and whitespace, drops the thousand separators (`.`), and treats
 * `,` as the decimal mark. Raw digits (`"100000"`) parse unchanged. Returns
 * `null` when the text holds no readable amount, so callers can stop loudly
 * instead of guessing.
 */
export function parseArsAmount(raw: string): number | null {
  const cleaned = raw.replace(/[$\s]/g, '');
  if (cleaned === '') return null;
  const normalized = cleaned.replace(/\./g, '').replace(/,/g, '.');
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/** Numeric equality on ARS amounts, robust to the mask's two-decimal display. */
export function arsAmountsEqual(expected: number, actual: number): boolean {
  return Math.round(expected * 100) === Math.round(actual * 100);
}

/**
 * The string to type into the masked input, digit by digit with real key
 * events, so the mask's cent accumulator lands on the approved amount: the
 * mask counts every typed digit as a cent, so 100000 ARS must be typed as
 * `"100000,00"` (eight digits → 10000000 cents → `$ 100.000,00`). Typing the
 * bare `"100000"` lands on `$ 1.000,00` — the observed live failure.
 */
export function formatArsTyping(amount: number): string {
  const cents = Math.round(amount * 100);
  const whole = Math.trunc(cents / 100);
  const decimals = String(Math.abs(cents % 100)).padStart(2, '0');
  return `${whole},${decimals}`;
}

/**
 * The panel's display format for a masked amount: `$` + space, thousands
 * grouped with `.`, two decimals after `,` — `$ 100.000,00`. The harness fake
 * mask renders exactly this so the readback mirrors the live panel.
 */
export function formatArsMask(amount: number): string {
  const cents = Math.round(amount * 100);
  const whole = Math.trunc(cents / 100);
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const decimals = String(Math.abs(cents % 100)).padStart(2, '0');
  return `$ ${grouped},${decimals}`;
}

/**
 * The canonical string an amount must have for hashing: the parsed number in
 * its plain form (`100000`), so the panel's `$ 100.000,00` and the approved
 * payload's `100000` hash identically. Unparsable text is returned unchanged —
 * the hash then mismatches and the run stops loudly.
 */
export function canonicalArsAmount(raw: string): string {
  const parsed = parseArsAmount(raw);
  return parsed === null ? raw : String(parsed);
}

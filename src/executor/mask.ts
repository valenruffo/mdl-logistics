/**
 * The panel's masked inputs (envioNube's panel knowledge, as a leaf module).
 *
 * The sucursal screen-P inputs carry an input mask, and the mask — not the
 * request — decides what the panel holds. Observed live (Posadas,
 * 2026-11-25, trace of `executor-2026-11-25T21-42-48-207Z`): the phone input
 * (`mask="999999999999999"`) kept only the typed text's **digits**, so an
 * approved `Teléfono` of `"376 463-4364"` was held as `"3764634364"`. Every
 * comparison the executor makes against a masked input must therefore use the
 * mask's own form — writing it, diffing it and hashing it — otherwise the
 * drift check sees false drift, its refill pass re-types the field (the
 * doubled `customer.phoneNumber` write the trace captured) and the walk
 * aborts before the package fill ever runs.
 */

/** The text a digit mask holds: the input's digits, nothing else. */
export function digitsMasked(value: string): string {
  return value.replace(/[^0-9]/g, '');
}

/**
 * The phone as the panel's masked input holds it — the digits of the approved
 * spelling (`"376 463-4364"` → `"3764634364"`), or the empty string for an
 * absent phone (the field is simply not written then).
 */
export function maskedPhoneOf(value: string | null): string {
  return value === null ? '' : digitsMasked(value);
}

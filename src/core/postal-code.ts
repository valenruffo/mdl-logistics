/**
 * The one and only definition of the accepted postal code shape for a manual
 * shipment (plan §4c: the panel's `[name="zipCode"]` on screen 1).
 *
 * It lives in `core` because two different entry points have to agree on it
 * byte for byte: the message parser validates the `Código postal` line with it,
 * and the editable preview validates the operator's edit with it. A second copy
 * would be a way for the preview to approve a code the parser refuses, or the
 * other way round.
 *
 * Accepted, uppercase, whitespace and hyphens removed:
 *
 * - 4 digits, leading zeros kept (`1901`, `0100`);
 * - 8 characters of a CPA (`B1900ABC`).
 *
 * Accents, case and stray separators are presentation, so normalization happens
 * before the test; anything that still does not match is refused with
 * `POSTAL_CODE_HINT` as the reason. Nothing is ever invented or padded.
 */
import { collapseWhitespace } from './normalize';

/** The reason to print when a value is not an accepted postal code. */
export const POSTAL_CODE_HINT = 'expected 4 digits (e.g. 1901) or an 8-character CPA (e.g. B1900ABC)';

/** 4-digit code (`1901`) or 8-character CPA (`B1900ABC`). */
const POSTAL_CODE_PATTERNS: readonly RegExp[] = [/^\d{4}$/, /^[A-Z]\d{4}[A-Z]{3}$/];

/** Strips internal spaces/hyphens and upper-cases, keeping the code comparable. */
export function normalizePostalCode(input: string): string {
  return collapseWhitespace(input).replace(/[\s-]/g, '').toUpperCase();
}

/** True only for the two accepted shapes, on an already normalized value. */
export function isPostalCode(value: string): boolean {
  return POSTAL_CODE_PATTERNS.some((pattern) => pattern.test(value));
}

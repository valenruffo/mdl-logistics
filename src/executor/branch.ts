/**
 * Branch identity by physical address (the operator's agreed rule).
 *
 * **The physical address — street + number — is the identity of a branch.**
 * Andreani's own site and the panel spell the same branch differently: the
 * panel decorates its dropdown option texts with a `Sucursal - ` (or
 * `Punto Andreani Hop - `) prefix and a trailing city name, while the customer
 * message carries the bare address. Prefixes, the repeated city name and
 * schedule text are decoration that varies between the two sides and never
 * participates in identity or matching.
 *
 * Everything here is deterministic string work in the same normalization family
 * as `../core/normalize` — lower-case, accent-free, whitespace-collapsed — and
 * additionally punctuation-free (`Av. San Martín` and `av san martin` are the
 * same street). No fuzzy matching, no external data, pure transforms only.
 */

import { collapseWhitespace, normalizeText } from '../core/normalize';

/** A parsed physical address: the street token run immediately before the number. */
export interface StreetNumberPair {
  /** Normalized, punctuation-free street tokens (`gral san martin`), decorative prefixes stripped. */
  street: string;
  /** The street number as a whole token (`979`). */
  number: string;
}

/** Lower-case, accent-free, punctuation-free, single-spaced tokens (`Av. San Martín, 979` → `av san martin 979`). */
export function normalizeAddressTokens(input: string): string {
  return collapseWhitespace(
    input
      .normalize('NFD')
      // Strip combining marks left by the NFD decomposition (á -> a + U+0301).
      .replace(/[\u0300-\u036f]/g, '')
      // Punctuation and symbols are decoration: dots, commas, dashes, `°`, parentheses.
      .replace(/[^\p{L}\p{N}\s]+/gu, ' '),
  ).toLowerCase();
}

function tokensOf(input: string): string[] {
  return normalizeAddressTokens(input)
    .split(' ')
    .filter((token) => token !== '');
}

/**
 * Leading decorative tokens of a branch street run — the panel's option-text
 * prefixes. Only these two observed forms are stripped, never a guessed list;
 * anything else is kept as part of the street.
 */
const DECORATIVE_STREET_PREFIXES: readonly string[][] = [['sucursal'], ['punto', 'andreani', 'hop']];

function stripDecorativeStreetPrefix(streetTokens: readonly string[]): string[] {
  let tokens = [...streetTokens];
  let stripped = true;
  while (stripped && tokens.length > 0) {
    stripped = false;
    for (const prefix of DECORATIVE_STREET_PREFIXES) {
      if (prefix.length <= tokens.length && prefix.every((token, index) => tokens[index] === token)) {
        tokens = tokens.slice(prefix.length);
        stripped = true;
      }
    }
  }
  return tokens;
}

/**
 * Parses the `(street, number)` pair out of a branch text: the **last** digit
 * token is the street number and the run of non-digit tokens immediately before
 * it is the street (decorative prefixes stripped). Returns `null` when there is
 * no number, or the number leads the text with no street in front of it — a
 * number alone is never an identity, and a street alone is never a match.
 */
export function parseStreetNumberPair(text: string): StreetNumberPair | null {
  const tokens = tokensOf(text);
  let numberIndex = -1;
  for (let index = tokens.length - 1; index >= 0; index--) {
    if (/^\d+$/.test(tokens[index]!)) {
      numberIndex = index;
      break;
    }
  }
  if (numberIndex <= 0) return null;
  const street: string[] = [];
  for (let index = numberIndex - 1; index >= 0 && !/^\d+$/.test(tokens[index]!); index--) {
    street.unshift(tokens[index]!);
  }
  const stripped = stripDecorativeStreetPrefix(street);
  if (stripped.length === 0) return null;
  return { street: stripped.join(' '), number: tokens[numberIndex]! };
}

/** True when `tokens` contains `needle` as a contiguous token run. */
function tokensContainRun(tokens: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > tokens.length) return false;
  for (let start = 0; start + needle.length <= tokens.length; start++) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset++) {
      if (tokens[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/** True when the text contains the street as a contiguous token run (candidates, before the number check). */
export function textContainsStreetTokens(text: string, street: string): boolean {
  return tokensContainRun(tokensOf(text), street.split(' '));
}

/**
 * True when the text contains the full pair — the street tokens **immediately
 * followed by the number as a whole token**. Street alone never matches: the
 * pair is (street AND number), so `(san martin, 979)` must not match a branch
 * whose number differs — and `San Martin 9790` contains `979` only as a
 * substring, never as a token, so it does not match either.
 */
export function textContainsStreetNumberPair(text: string, pair: StreetNumberPair): boolean {
  const tokens = tokensOf(text);
  const streetTokens = pair.street.split(' ');
  for (let index = streetTokens.length; index < tokens.length; index++) {
    if (tokens[index] !== pair.number) continue;
    const start = index - streetTokens.length;
    if (streetTokens.every((token, offset) => tokens[start + offset] === token)) return true;
  }
  return false;
}

/**
 * The identity string used for every branch comparison (approval hash and
 * readback diff): `street #number` when a pair can be parsed, else the
 * normalized full text (a branch name with no number keeps exact-text
 * identity). The panel's `Sucursal - Gral. San Martin 979 San Salvador de
 * Jujuy, Jujuy` and the customer's `Gral. San Martin 979 San Salvador de Jujuy`
 * share one identity; two branches on the same street with different numbers
 * never do.
 */
export function branchIdentity(name: string): string {
  const pair = parseStreetNumberPair(name);
  if (pair !== null) return `${pair.street} #${pair.number}`;
  return normalizeText(name);
}

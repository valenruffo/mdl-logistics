/**
 * Branch identity by physical address (the operator's agreed rule).
 *
 * **The physical address identifies a branch, by its last word + the number.**
 * The operator's rule: within one postal code, addresses never repeat, so one
 * word and the number are enough — `beiro 4470` is `Av. Francisco Beiró, 4470`,
 * and a multi-word street name is decoration beyond that pair. Andreani's own
 * site and the panel spell the same branch differently: the panel decorates its
 * dropdown option texts with a `Sucursal - ` (or `Punto Andreani Hop - `)
 * prefix and a trailing city name, while the customer message carries the bare
 * address. Prefixes, `av`-style street-type words, the repeated city name and
 * schedule text are decoration that varies between the two sides and never
 * participates in identity or matching.
 *
 * Everything here is deterministic string work in the same normalization family
 * as `../core/normalize` — lower-case, accent-free, whitespace-collapsed — and
 * additionally punctuation-free (`Av. San Martín` and `av san martin` are the
 * same street). No fuzzy matching, no external data, pure transforms only.
 */

import { collapseWhitespace, normalizeText } from '../core/normalize';

/** A parsed address pair: the **last non-digit word** before the number + the number. */
export interface StreetNumberPair {
  /** The single normalized, punctuation-free word right before the number (`martin`, `beiro`). */
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
 * Leading dash-separated decoration of the panel's option text — the panel
 * separates its own decoration from the address with a whitespace-dash
 * separator (`Jujuy (Centro) - `, `Sucursal - `). A dash segment that carries
 * no digit token can never hold the street number, so it is decoration and is
 * dropped; the first digit-bearing segment is the address itself, dashes and
 * all. Returns the text unchanged when there is no separator.
 */
function stripDashSeparatedDecoration(text: string): string {
  let rest = text;
  for (;;) {
    const separator = /\s[-–—]\s/.exec(rest);
    if (separator === null) return rest;
    const head = rest.slice(0, separator.index);
    rest = rest.slice(separator.index + separator[0].length);
    if (tokensOf(head).some((token) => /^\d+$/.test(token))) return text;
  }
}

/** The token-level parse: the **last non-digit word** immediately before the last digit token. */
function parsePairFromTokens(text: string): StreetNumberPair | null {
  const tokens = tokensOf(text);
  let numberIndex = -1;
  for (let index = tokens.length - 1; index >= 0; index--) {
    if (/^\d+$/.test(tokens[index]!)) {
      numberIndex = index;
      break;
    }
  }
  if (numberIndex <= 0) return null;
  // The pair is the last non-digit word before the number (`Gral. San Martin
  // 979 …` → `martin`; `Av Beiro 4470` → `beiro`, the `av` prefix drops out by
  // itself). Every word further left is street-name decoration.
  if (/^\d+$/.test(tokens[numberIndex - 1]!)) return null;
  const wordIndex = numberIndex - 1;
  const stripped = stripDecorativeStreetPrefix([tokens[wordIndex]!]);
  if (stripped.length === 0) return null;
  return { street: stripped[0]!, number: tokens[numberIndex]! };
}

/**
 * Parses the `(word, number)` pair out of a branch text — the **one
 * extraction** shared by the pair matcher and `branchIdentity`, so both sides
 * of every comparison use the same adjacency: the pair is the **last non-digit
 * word immediately before the last digit token** (the number). The panel's
 * dash-separated decoration (`Jujuy (Centro) - Gral. San Martín, 979, …`) is
 * dropped before the parse; if dropping it yields no pair, the full text parses
 * instead, so a dash inside the address itself (`Av. X - 1234`) keeps its pair.
 * Returns `null` when there is no number, or the number leads the text with no
 * word in front of it — a number alone is never an identity, and a word alone
 * is never a match.
 */
export function parseStreetNumberPair(text: string): StreetNumberPair | null {
  const address = stripDashSeparatedDecoration(text);
  if (address !== text) {
    const pair = parsePairFromTokens(address);
    if (pair !== null) return pair;
  }
  return parsePairFromTokens(text);
}

/** True when the text contains the word as a whole token (candidates, before the number check). */
export function textContainsStreetTokens(text: string, street: string): boolean {
  return tokensOf(text).includes(street);
}

/**
 * True when the text contains the pair — the word **immediately followed by
 * the number as whole tokens**. Word alone never matches: the pair is (word
 * AND number), so `(beiro, 4470)` must not match a branch whose number differs
 * (the Lamadrid entre-calles case) — and `9790` contains `979` only as a
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
 * readback diff): `word #number` when a pair can be parsed — by the **same
 * extraction** the pair matcher uses (`parseStreetNumberPair`: same punctuation
 * stripping, same adjacency, same dash-decoration stripping) — else the
 * normalized full text (a branch name with no number keeps exact-text
 * identity). The panel's `Sucursal - Gral. San Martin 979 San Salvador de Jujuy,
 * Jujuy`, its echoed `Jujuy (Centro) - Gral. San Martín, 979, San Salvador De
 * Jujuy, Jujuy` and the customer's `Gral. San Martin 979 San Salvador de Jujuy`
 * share one identity (`martin #979`); two branches with different numbers (or
 * different last words) never do.
 */
export function branchIdentity(name: string): string {
  const pair = parseStreetNumberPair(name);
  if (pair !== null) return `${pair.street} #${pair.number}`;
  return normalizeText(name);
}

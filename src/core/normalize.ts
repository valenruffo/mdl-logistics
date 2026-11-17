/**
 * Text normalization primitives shared by the parser and the province alias map.
 *
 * Everything here is deterministic: no locale-dependent collation, no fuzzy
 * matching, no external data. Pure string transforms only.
 */

/** Collapses any whitespace run (tabs, NBSP, newlines) to one space and trims. */
export function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

/**
 * The single comparison form for text read from the panel or written in this
 * repository: lower case, accent-free, one space between tokens.
 *
 * `Código`, `código`, `CODIGO` and a decomposed `co` + U+0301 + `digo` all
 * collapse to `codigo`; `El código de seguimiento` and
 * `EL  CODIGO DE SEGUIMIENTO` are the same string.
 *
 * Every heading, badge and card-text comparison goes through this helper (or
 * `sameText` / `textContains` below). Comparison over raw prose is what turned a
 * real, successful creation into "the label cannot be proven unpaid": the panel
 * renders interface copy in a case and accent shape no hard-coded fragment can
 * assume.
 */
export function normalizeText(input: string): string {
  return collapseWhitespace(
    input
      .normalize('NFD')
      // Strip combining marks left by the NFD decomposition (á -> a + U+0301).
      // Some panels render accented copy decomposed, so this is also the reason
      // a raw `includes` on `código` can miss its own visible text.
      .replace(/[\u0300-\u036f]/g, ''),
  ).toLowerCase();
}

/** True when both texts are identical after `normalizeText` (whole string). */
export function sameText(left: string, right: string): boolean {
  return normalizeText(left) === normalizeText(right);
}

/** True when `haystack` contains `needle` after `normalizeText` (substring). */
export function textContains(haystack: string, needle: string): boolean {
  return normalizeText(haystack).includes(normalizeText(needle));
}

/**
 * Builds the key used for every table lookup (labels, section headings,
 * province aliases): accent-insensitive, case-insensitive, dot-insensitive.
 *
 * `C.A.B.A.` and `caba` collapse to the same key; `CÓRDOBA` and `Cordoba` too.
 */
export function normalizeLookupKey(input: string): string {
  // Collapse again after the dots are gone: `a . b` must not keep a double space.
  return collapseWhitespace(normalizeText(input).replaceAll('.', ''));
}

/**
 * Removes trailing parenthetical abbreviations ("Ciudad Autónoma de Buenos
 * Aires (CABA)" -> "Ciudad Autónoma de Buenos Aires").
 *
 * If nothing survives the strip, the original text is returned so that an
 * abbreviation-only input like "(CABA)" is still matched instead of vanishing.
 */
export function stripTrailingParenthetical(input: string): string {
  const stripped = collapseWhitespace(input.replace(/(\s*\([^()]*\))+\s*$/, ''));
  return stripped === '' ? collapseWhitespace(input) : stripped;
}

/**
 * Strips WhatsApp formatting markers (`*` bold, `_` italic, `~` strikethrough,
 * `` ` `` monospace) from both edges of a label, heading or value, together
 * with the surrounding whitespace.
 *
 * Edge-only by design: a marker *inside* a value is data the operator typed
 * (`Calle 1*2`), not formatting, so it is preserved. Unknown text stays unknown
 * after stripping — nothing here guesses.
 */
export function stripFormattingMarkers(input: string): string {
  return collapseWhitespace(
    collapseWhitespace(input)
      .replace(/^[\s*_~`]+/, '')
      .replace(/[\s*_~`]+$/, ''),
  );
}

/** True when the text carries no uppercase letters at all. */
export function isAllLowercase(input: string): boolean {
  return input === input.toLowerCase();
}

/** Upper-cases the first letter of every space-separated token, lower-cases the rest. */
export function titleCase(input: string): string {
  return collapseWhitespace(input)
    .split(' ')
    .map((token) => {
      const characters = Array.from(token);
      const [first, ...rest] = characters;
      if (first === undefined) return '';
      return first.toUpperCase() + rest.join('').toLowerCase();
    })
    .join(' ');
}

/** Splits a full name into the panel's two fields: first token, then the rest. */
export function splitFullName(input: string): { name: string; lastName: string | null } {
  const tokens = collapseWhitespace(input).split(' ').filter((token) => token !== '');
  const [first, ...rest] = tokens;
  return {
    name: first ?? '',
    lastName: rest.length > 0 ? rest.join(' ') : null,
  };
}

/**
 * Interface-copy matching for the panel.
 *
 * Playwright's own text matching is case-insensitive for ASCII but accent-blind
 * in the other direction: a locator for `Crear envío` never finds `Crear envio`,
 * and a locator for `Crear envio` never finds `Crear envío`. Both are the same
 * copy. This module builds the regular expression that accepts every spelling of
 * one piece of copy — any case, with or without accents, any whitespace run — so
 * a locator can never miss the panel's own text over how it happens to encode it.
 *
 * One matcher for copy, one normalizer for comparisons (`normalizeText`): no
 * second convention is allowed to grow beside them.
 */
import { collapseWhitespace } from '../core/normalize';

/**
 * Accented spellings of each base letter that this UI actually uses. The `i`
 * flag of the generated pattern covers the upper-case spellings.
 */
const ACCENT_VARIANTS: Readonly<Record<string, string>> = {
  a: 'áàäâãå',
  c: 'ç',
  e: 'éèëê',
  i: 'íìïî',
  n: 'ñ',
  o: 'óòöôõ',
  u: 'úùüû',
  y: 'ýÿ',
};

export interface CopyPatternOptions {
  /**
   * Anchor to the whole accessible text. Playwright's default is a substring
   * match; anchoring is used where a looser match would widen a click target.
   */
  exact?: boolean;
}

/**
 * Combining marks that may follow one letter when the DOM renders the copy
 * decomposed (`o` + U+0301 instead of `ó`). Applied after every letter, so both
 * encodings of the same copy match.
 */
const COMBINING_MARKS = '[\\u0300-\\u036f]*';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A matcher for one piece of interface copy: case-insensitive, accent-insensitive,
 * whitespace-insensitive, and a substring match unless `exact` is set.
 *
 * `copyPattern('Código de seguimiento')` matches `código de seguimiento`,
 * `CODIGO  DE SEGUIMIENTO` and `Codigo\u00a0de seguimiento` alike.
 */
export function copyPattern(text: string, options: CopyPatternOptions = {}): RegExp {
  const base = collapseWhitespace(text.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
  let body = '';
  for (const character of Array.from(base)) {
    if (/\s/.test(character)) {
      body += '\\s+';
      continue;
    }
    const lower = character.toLowerCase();
    const variants = ACCENT_VARIANTS[lower];
    body +=
      variants === undefined
        ? `${escapeRegExp(lower)}${COMBINING_MARKS}`
        : `[${lower}${variants}]${COMBINING_MARKS}`;
  }
  // Adjacent whitespace characters each emitted `\s+`; one run is enough.
  body = body.replace(/(?:\\s\+)+/g, '\\s+');
  if (body === '') return /^\s*$/;
  return options.exact === true ? new RegExp(`^\\s*${body}\\s*$`, 'i') : new RegExp(body, 'i');
}

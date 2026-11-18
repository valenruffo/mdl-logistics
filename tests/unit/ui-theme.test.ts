/**
 * The console's readability and its theme, as measurements.
 *
 * The deployed page had two faults that no screenshot review caught:
 *
 * 1. **The rail's blocks were cards.** A bare `section` rule gave every section a
 *    white fill and a border, so the rail's own light palette landed on white:
 *    `SESIÓN`, `CORRIDAS`, `ERRORES`, `ARTEFACTOS` and their body text came out
 *    light grey on white, and `Verificar ahora` nearly vanished. The artboard has
 *    no card inside the rail. The first test asserts the structural half of that
 *    fix; the contrast tests below assert the measured half.
 * 2. **There was no dark page.** The rail was dark and everything else was not.
 *
 * The contrast assertions **compute** the WCAG AA ratio from the token values
 * that the page's CSS actually declares. Nothing here hardcodes a number: a
 * token that drifts darker or lighter is measured again, and a pair that falls
 * under 4.5 fails with the ratio it reached.
 *
 * Everything is offline: the page and the script are imported as strings.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { CLIENT_JS, PAGE_HTML } from '../../src/ui/server';

// ------------------------------------------------------------------- CSS shape

interface Rule {
  selector: string;
  body: string;
}

/** The page's own stylesheet, without the `<style>` tags and without comments. */
function styleOf(html: string): string {
  const open = html.indexOf('<style>');
  const close = html.indexOf('</style>');
  assert.ok(open >= 0 && close > open, 'the page carries one style block');
  return html
    .slice(open + '<style>'.length, close)
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Every flat rule in the sheet. A block with braces inside (an `@media` wrapper)
 * is not a rule itself, so its inner rules are the ones collected — which is
 * exactly what these assertions need.
 */
function rulesOf(css: string): Rule[] {
  const rules: Rule[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null = pattern.exec(css);
  while (match !== null) {
    const selector = (match[1] ?? '').trim();
    const body = match[2] ?? '';
    if (selector !== '' && !selector.startsWith('@')) rules.push({ selector, body });
    match = pattern.exec(css);
  }
  return rules;
}

function selectorsOf(rule: Rule): string[] {
  return rule.selector.split(',').map((part) => part.trim());
}

function rulesWith(css: string, selector: string): Rule[] {
  return rulesOf(css).filter((rule) => selectorsOf(rule).includes(selector));
}

function oneRule(css: string, selector: string): Rule {
  const found = rulesWith(css, selector);
  assert.equal(found.length, 1, `the stylesheet declares exactly one "${selector}" rule, found ${found.length}`);
  return found[0] as Rule;
}

function declarations(body: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of body.split(';')) {
    const colon = part.indexOf(':');
    if (colon <= 0) continue;
    const name = part.slice(0, colon).trim();
    const value = part.slice(colon + 1).trim();
    if (name === '' || value === '') continue;
    map.set(name, value);
  }
  return map;
}

/** The custom properties a rule declares, e.g. `--ink` -> `#15181d`. */
function tokensOf(body: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const [name, value] of declarations(body)) {
    if (name.startsWith('--')) map.set(name, value);
  }
  return map;
}

function merged(...maps: Map<string, string>[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const map of maps) for (const [key, value] of map) out.set(key, value);
  return out;
}

/** A token's colour, following `var(--other)` one hop at a time. */
function colorOf(tokens: Map<string, string>, name: string): string {
  const raw = tokens.get(name);
  assert.ok(raw !== undefined, `the stylesheet declares ${name}`);
  const value = raw.trim();
  const reference = /^var\(\s*(--[a-z0-9-]+)\s*\)$/.exec(value);
  if (reference) return colorOf(tokens, reference[1] as string);
  assert.match(value, /^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$/, `${name} must be a plain hex colour, found ${value}`);
  return value;
}

// ------------------------------------------------------------- WCAG AA ratios

function linearChannel(component: number): number {
  const scaled = component / 255;
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

function toHex(hex: string): string {
  const digits = hex.replace('#', '');
  if (digits.length === 6) return digits;
  return digits
    .split('')
    .map((digit) => digit + digit)
    .join('');
}

function relativeLuminance(hex: string): number {
  const digits = toHex(hex);
  assert.equal(digits.length, 6, `a 3- or 6-digit hex colour was measured, found ${hex}`);
  const red = linearChannel(parseInt(digits.slice(0, 2), 16));
  const green = linearChannel(parseInt(digits.slice(2, 4), 16));
  const blue = linearChannel(parseInt(digits.slice(4, 6), 16));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** The WCAG 2.x contrast ratio: (L1 + 0.05) / (L2 + 0.05), lighter first. */
function contrastRatio(foreground: string, background: string): number {
  const one = relativeLuminance(foreground);
  const other = relativeLuminance(background);
  const lighter = Math.max(one, other);
  const darker = Math.min(one, other);
  return (lighter + 0.05) / (darker + 0.05);
}

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

/** Measured pairs, kept so the report at the bottom names the same numbers. */
const measured: { pair: string; ratio: number }[] = [];

function assertPair(label: string, foreground: string, background: string, minimum: number): number {
  const ratio = contrastRatio(foreground, background);
  assert.ok(
    Number.isFinite(ratio) && ratio > 0,
    `${label}: the ratio has to be computed from two colours, got ${String(ratio)}`,
  );
  const rounded = Math.round(ratio * 100) / 100;
  measured.push({ pair: label, ratio: rounded });
  assert.ok(
    ratio >= minimum,
    `${label}: ${foreground} on ${background} measures ${rounded}:1, under the ${minimum}:1 required`,
  );
  return rounded;
}

// ------------------------------------------------------------- the two themes

const CSS = styleOf(PAGE_HTML);
const LIGHT = merged(tokensOf(oneRule(CSS, ':root').body));
const DARK_MANUAL = tokensOf(oneRule(CSS, 'html[data-theme="dark"]').body);
const DARK_MEDIA = tokensOf(oneRule(CSS, 'html:not([data-theme="light"])').body);
const DARK = merged(LIGHT, DARK_MANUAL);

// ------------------------------------------- 1. the rail's blocks are not cards

test('the rail carries no cards: no bare section rule fills a block, and the rail resets every one', () => {
  // The regression: a bare `section { background:var(--surface); ... }` dressed
  // the rail's blocks as white cards and put the rail's palette on white.
  const cardProperties = ['background', 'background-color', 'border', 'border-radius', 'box-shadow'];
  for (const rule of rulesOf(CSS)) {
    if (!selectorsOf(rule).includes('section')) continue;
    const declared = declarations(rule.body);
    for (const property of cardProperties) {
      assert.equal(
        declared.has(property),
        false,
        `"${rule.selector}" styles every section, rail included: ${property} belongs on .work section`,
      );
    }
  }

  // The work column keeps its cards...
  const work = declarations(oneRule(CSS, '.work section').body);
  assert.equal(work.get('background'), 'var(--surface)', 'the work column keeps its surface');
  assert.match(work.get('border') ?? '', /1px solid var\(--line\)/, 'the work column keeps its border');
  assert.match(work.get('border-radius') ?? '', /\d/, 'the work column keeps its radius');
  assert.match(work.get('padding') ?? '', /\d/, 'the work column keeps its padding');

  // ...and the rail's blocks sit directly on the dark surface.
  const rail = declarations(oneRule(CSS, '.rail section').body);
  assert.match(rail.get('background') ?? '', /^(none|transparent)$/, 'the rail blocks have no fill');
  assert.equal(rail.get('border'), '0', 'the rail blocks have no border');
  assert.equal(rail.get('border-radius'), '0', 'the rail blocks have no radius');
  assert.equal(rail.get('box-shadow'), 'none', 'the rail blocks have no shadow');
  assert.equal(rail.get('padding'), '0', 'the rail blocks add no card padding');

  // The spacing between cards is scoped the same way, so the rail's flex gap
  // is the only thing spacing the rail out.
  assert.equal(rulesWith(CSS, 'section + section').length, 0, 'section spacing is scoped to .work');
  assert.equal(rulesWith(CSS, '.work section + section').length, 1, '.work keeps its section spacing');

  // The rail's text tokens are the artboard's, and the section labels use the
  // muted one at a small size — which is why it is measured below.
  assert.match(oneRule(CSS, '.rail h2').body, /color:var\(--rail-muted\)/, 'the section labels use the rail muted ink');
});

// -------------------------------------------------- 2. the measured contrasts

test('every required pair clears WCAG AA, measured from the tokens the stylesheet declares', () => {
  // A control on the ratio function itself, so a broken formula cannot pass by
  // declaring everything to be readable.
  assert.equal(Math.round(contrastRatio('#000000', '#ffffff') * 100) / 100, 21, 'black on white is 21:1');
  assert.equal(Math.round(contrastRatio('#ffffff', '#000000') * 100) / 100, 21, 'and the order does not matter');

  const lightSurface = colorOf(LIGHT, '--surface');
  const lightBg = colorOf(LIGHT, '--bg');
  const railSurface = colorOf(LIGHT, '--rail');
  const darkSurface = colorOf(DARK, '--surface');
  const darkBg = colorOf(DARK, '--bg');

  // The four pairs the fix is about.
  assertPair(
    'rail text on rail surface',
    colorOf(LIGHT, '--rail-ink'),
    railSurface,
    AA_TEXT,
  );
  assertPair(
    'rail muted on rail surface',
    colorOf(LIGHT, '--rail-muted'),
    railSurface,
    AA_TEXT,
  );
  assertPair('body text on the light surface', colorOf(LIGHT, '--ink'), lightSurface, AA_TEXT);
  assertPair('body text on the dark surface', colorOf(DARK, '--ink'), darkSurface, AA_TEXT);

  // The same two surfaces again for the body text that sits on the page
  // background rather than on a card, and for the muted body size.
  assertPair('light muted on the light surface', colorOf(LIGHT, '--muted'), lightSurface, AA_TEXT);
  assertPair('light muted on the page background', colorOf(LIGHT, '--muted'), lightBg, AA_TEXT);
  assertPair('dark muted on the dark surface', colorOf(DARK, '--muted'), darkSurface, AA_TEXT);
  assertPair('dark muted on the dark background', colorOf(DARK, '--muted'), darkBg, AA_TEXT);

  // Anything inside the rail is on the rail surface, including its notice text.
  assertPair('rail notice text on rail surface', colorOf(LIGHT, '--rail-muted'), railSurface, AA_TEXT);

  // The rail's own status words: the dots carry colour, the words carry meaning.
  for (const name of ['--rail-ok', '--rail-warn', '--rail-bad']) {
    assertPair(`${name} on rail surface`, colorOf(LIGHT, name), railSurface, AA_TEXT);
  }

  // Controls: a label at 4.5:1 on the surface it sits on, hover and disabled
  // included, plus a border and a focus ring that are visible as an edge.
  assertPair(
    'rail control label on rail hover',
    colorOf(LIGHT, '--rail-ink'),
    colorOf(LIGHT, '--rail-hover'),
    AA_TEXT,
  );
  assertPair('rail control border against the rail', colorOf(LIGHT, '--rail-edge'), railSurface, AA_NON_TEXT);
  assert.match(
    oneRule(CSS, '.rail button').body,
    /border:1px solid var\(--rail-edge\)/,
    'the rail control draws that border',
  );
  assertPair('rail focus ring on the rail', colorOf(LIGHT, '--rail-focus'), railSurface, AA_NON_TEXT);
  assert.match(oneRule(CSS, '.rail :focus-visible').body, /outline-color:var\(--rail-focus\)/);

  // Focus rings elsewhere, on both themes.
  assertPair('light focus ring on the page', colorOf(LIGHT, '--focus'), lightBg, AA_NON_TEXT);
  assertPair('dark focus ring on the dark surface', colorOf(DARK, '--focus'), darkSurface, AA_NON_TEXT);

  // The work column's buttons: primary label, and the disabled label that used
  // to be `opacity:.5` on the whole control.
  assertPair('primary label on the accent', colorOf(LIGHT, '--accent-ink'), colorOf(LIGHT, '--accent'), AA_TEXT);
  assertPair(
    'disabled primary label on its light fill',
    colorOf(LIGHT, '--muted'),
    colorOf(LIGHT, '--accent-off'),
    AA_TEXT,
  );
  assertPair(
    'disabled primary label on its dark fill',
    colorOf(DARK, '--muted'),
    colorOf(DARK, '--accent-off'),
    AA_TEXT,
  );
  assertPair('disabled ghost label on the light surface', colorOf(LIGHT, '--muted'), lightSurface, AA_TEXT);
  assertPair('disabled ghost label on the dark surface', colorOf(DARK, '--muted'), darkSurface, AA_TEXT);

  // Status text in the work column, in both themes.
  for (const name of ['--ok-text', '--warn-text', '--bad-text']) {
    assertPair(`${name} on the light surface`, colorOf(LIGHT, name), lightSurface, AA_TEXT);
    assertPair(`${name} on the dark surface`, colorOf(DARK, name), darkSurface, AA_TEXT);
  }

  // Nothing is faded with an opacity that would ruin those labels.
  assert.doesNotMatch(oneRule(CSS, '.rail button:disabled').body, /opacity/, 'the disabled rail control keeps its label');
  assert.doesNotMatch(
    CSS,
    /button\.(primary|ghost):disabled[^{}]*\{[^{}]*opacity/,
    'a disabled work-column button keeps its label readable',
  );

  assert.ok(measured.length >= 20, `every pair above was measured, got ${measured.length}`);
});

// ------------------------------------------------- 3. the dark theme and the toggle

test('the dark theme exists twice, with the same tokens, and the stored choice wins over the system', () => {
  // The system-driven block and the hand-picked block must not drift apart.
  assert.deepEqual(
    [...DARK_MEDIA.entries()].sort(),
    [...DARK_MANUAL.entries()].sort(),
    'the prefers-color-scheme block and the data-theme block declare identical tokens',
  );
  assert.ok(DARK_MANUAL.size >= 8, `the dark block overrides the surfaces and the text, got ${DARK_MANUAL.size}`);

  // The values the fix asks for, read from the block rather than restated.
  assert.equal(colorOf(DARK, '--bg').toLowerCase(), '#0e1116', 'the dark page background');
  assert.equal(colorOf(DARK, '--surface').toLowerCase(), '#151a21', 'the dark surface');
  assert.equal(colorOf(DARK, '--line').toLowerCase(), '#252c36', 'the dark border');
  assert.equal(colorOf(DARK, '--ink').toLowerCase(), '#dfe3e9', 'the dark primary text');
  assert.equal(colorOf(DARK, '--muted').toLowerCase(), '#8b93a1', 'the dark muted text');
  assert.equal(colorOf(DARK, '--accent').toLowerCase(), colorOf(LIGHT, '--accent').toLowerCase(), 'the same accent');

  // `color-scheme` is declared for both themes, so form controls and scrollbars
  // match instead of turning into a light widget in the dark page.
  assert.match(oneRule(CSS, ':root').body, /color-scheme:\s*light/, 'the light theme declares color-scheme:light');
  assert.match(oneRule(CSS, 'html[data-theme="dark"]').body, /color-scheme:\s*dark/, 'the dark choice declares color-scheme:dark');
  assert.match(
    oneRule(CSS, 'html:not([data-theme="light"])').body,
    /color-scheme:\s*dark/,
    'the system-driven dark block declares color-scheme:dark',
  );
  assert.match(PAGE_HTML, /<meta name="color-scheme" content="light dark">/, 'the document declares both schemes');

  // The manual choice is unconditional; the system block is skipped when the
  // operator stored `light`. That is what makes the stored choice win.
  assert.match(CSS, /@media \(prefers-color-scheme: dark\)/, 'the dark scheme block exists');
  const manualAt = CSS.indexOf('html[data-theme="dark"]');
  const mediaAt = CSS.indexOf('@media (prefers-color-scheme: dark)');
  assert.ok(manualAt >= 0 && mediaAt > manualAt, 'the hand-picked block is declared before the media query');
});

test('the theme toggle is in the rail and its choice persists through localStorage', () => {
  // The markup: a real button inside the rail, so it is reachable on a phone too.
  const railStart = PAGE_HTML.indexOf('<aside class="rail"');
  const railEnd = PAGE_HTML.indexOf('</aside>');
  const toggleAt = PAGE_HTML.indexOf('id="theme-toggle"');
  assert.ok(railStart >= 0 && railEnd > railStart, 'the page has its rail');
  assert.ok(toggleAt > railStart && toggleAt < railEnd, 'the toggle lives inside the rail');
  assert.match(PAGE_HTML, /<button type="button" id="theme-toggle"[^>]*aria-pressed="false"/, 'it is a toggle button');

  // Both scripts use one key. The head applies it before the first paint, so a
  // dark page never flashes light; the script writes it when the operator picks.
  const bootstrapKey = /localStorage\.getItem\('([^']+)'\)/.exec(PAGE_HTML);
  assert.ok(bootstrapKey, 'the head of the page reads the stored theme');
  const clientKey = /THEME_KEY\s*=\s*'([^']+)'/.exec(CLIENT_JS);
  assert.ok(clientKey, 'the script names the key it writes');
  assert.equal(clientKey[1], bootstrapKey[1], 'both scripts agree on the key');

  const beforeBody = PAGE_HTML.slice(0, PAGE_HTML.indexOf('<body'));
  assert.match(
    beforeBody,
    /localStorage\.getItem\('mdl-theme'\)/,
    'the stored theme is read in the head, before the body is parsed',
  );
  assert.match(beforeBody, /document\.documentElement\.setAttribute\('data-theme'/, 'and applied to the root element');

  // The toggle writes the key and re-applies the attribute.
  assert.match(CLIENT_JS, /localStorage\.setItem\(THEME_KEY, next\)/, 'the click persists the choice');
  assert.match(CLIENT_JS, /getElementById|byId\('theme-toggle'\)/, 'the script finds the toggle');
  assert.match(CLIENT_JS, /addEventListener\('click', toggleTheme\)/, 'the toggle switches the theme');
  assert.match(CLIENT_JS, /document\.documentElement\.setAttribute\('data-theme'/, 'the script applies the theme');
  assert.match(
    CLIENT_JS,
    /document\.documentElement\.removeAttribute\('data-theme'\)/,
    'and can hand the page back to the system',
  );

  // The stored choice wins: the system query is consulted only while nothing is
  // stored, and `effectiveTheme` prefers the stored value.
  assert.match(
    CLIENT_JS,
    /function effectiveTheme\(\)[\s\S]*?return saved === null \? systemTheme\(\) : saved;/,
    'a stored choice beats the system preference',
  );
  assert.match(CLIENT_JS, /'\(prefers-color-scheme: dark\)'/, 'the system preference is still read');
  assert.match(CLIENT_JS, /catch \(ignored\)/, 'a browser that refuses localStorage does not break the page');
});

// ---------------------------------------------------------- 4. no native dialog

test('neither the page nor the client script can open a native dialog', () => {
  for (const [name, source] of [
    ['the page', PAGE_HTML],
    ['the client script', CLIENT_JS],
  ] as const) {
    for (const call of ['alert(', 'confirm(', 'prompt(']) {
      assert.equal(source.includes(call), false, `${name} must not contain ${call}`);
    }
    // The same dialog by another name.
    assert.equal(source.includes('window.'), false, `${name} must not reach through window`);
  }
});

/**
 * The visible version, as the operator asked for it: "en el dash tenés que
 * poner la versión nueva y el número ahí abajo en el sidebar, así ya sé si
 * estoy en la versión del cambio o debo esperar o recargar".
 *
 * Three guarantees:
 *
 * 1. **One source of truth.** The page constant and `package.json` are pinned
 *    together (ui-flow pins it too; this file asserts the changelog's newest
 *    entry is that same version, so a bump cannot ship without its note).
 * 2. **The changelog is on the page.** The footer popover lists what each
 *    recent version carried — the `0.2.0` and `0.1.0` entries are in the HTML.
 * 3. **No dialogs.** The popover is CSS only: a hidden checkbox toggled by the
 *    version label. No `<dialog>`, no `alert`/`confirm`/`prompt`, and no
 *    client script involvement.
 *
 * Everything is offline: the page and the script are imported as strings.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { APP_VERSION, CHANGELOG, PAGE_HTML } from '../../src/ui/page';
import { CLIENT_JS } from '../../src/ui/server';

// ------------------------------------------------- 1. one source of truth

test('the package version, the page constant and the newest changelog entry agree', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), { encoding: 'utf8' }),
  ) as { version: string };

  assert.equal(APP_VERSION, manifest.version, 'the rail footer must not drift from package.json');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/, 'the version is a plain semver string');

  assert.ok(CHANGELOG.length >= 2, 'the changelog lists more than the current version');
  assert.equal(CHANGELOG[0]?.version, APP_VERSION, 'the newest changelog entry is the shipped version');
});

// ---------------------------------------------- 2. the changelog is on the page

test('the footer popover carries the 0.2.0 and 0.1.0 entries with their notes', () => {
  // The version the footer prints is the package version, as before.
  assert.ok(PAGE_HTML.includes(`v${APP_VERSION}`), 'the footer prints the package version');

  // The popover markup is rendered from CHANGELOG, so every entry is on the page.
  for (const entry of CHANGELOG) {
    assert.ok(PAGE_HTML.includes(`v${entry.version}`), `the popover names v${entry.version}`);
    assert.ok(PAGE_HTML.includes(entry.note), `the popover carries the note for v${entry.version}`);
  }

  // The two entries the operator asked to see, asserted literally.
  assert.match(PAGE_HTML, /v0\.2\.0<\/strong> — sucursal punta a punta/);
  assert.match(PAGE_HTML, /v0\.1\.0<\/strong> — MVP domicilio/);
});

// -------------------------------------------------------- 3. no dialogs, no JS

test('the version popover is CSS only: a checkbox toggle, never a dialog or a script', () => {
  // The toggle mechanism: a hidden checkbox and a label wired to it.
  assert.match(PAGE_HTML, /<input type="checkbox" id="ver-changelog" class="ver-toggle"/);
  assert.match(PAGE_HTML, /<label for="ver-changelog" class="ver-label">v\d+\.\d+\.\d+<\/label>/);

  // Hidden by default, opened on tap (:checked) and on keyboard focus.
  assert.match(PAGE_HTML, /\.ver-popover \{ display:none/, 'the popover is closed until toggled');
  assert.match(PAGE_HTML, /\.ver-toggle:checked ~ \.ver-popover[^{]*\{ display:block/, 'tapping the version opens it');
  assert.match(PAGE_HTML, /\.ver-toggle:focus-visible ~ \.ver-popover[^{]*\{ display:block/, 'the keyboard opens it too');

  // No dialogs by any name, and the client script never touches the popover.
  assert.doesNotMatch(PAGE_HTML, /<dialog/i, 'no dialog element');
  for (const call of ['alert(', 'confirm(', 'prompt(']) {
    assert.equal(PAGE_HTML.includes(call), false, `the page must not contain ${call}`);
    assert.equal(CLIENT_JS.includes(call), false, `the client script must not contain ${call}`);
  }
  assert.doesNotMatch(CLIENT_JS, /ver-changelog|ver-popover|ver-label/, 'the popover needs no JavaScript');
});

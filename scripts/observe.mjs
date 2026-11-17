/**
 * Observation harness for discovering the real Envío Nube form.
 *
 * Two findings forced this design:
 *  1. Playwright Codegen attached its recorder to the top document, and the Envío Nube UI lives
 *     in a cross-origin iframe (`services-ne-app-front-ar.nuvemshop.com.br`), so user clicks
 *     produced no recorded actions.
 *  2. Envío Nube routes with a hash fragment (`#/create-single-shipment`), so the frame persists
 *     across screens and must be located by URL, never by index.
 *
 * It never clicks, fills or submits anything. Read-only by construction (R10).
 *
 * Trigger: create `artifacts/.dump-requested`. Every frame of the active page is then dumped to
 * `artifacts/dom-dump-<timestamp>.json`.
 *
 * The profile lives outside the repository because it contains the authenticated session (R15).
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const PROFILE = process.env.MDL_PROFILE ?? 'C:\\Users\\valen\\.mdl\\browser-profile';
const ARTIFACTS = path.resolve('artifacts');
const TRIGGER = path.join(ARTIFACTS, '.dump-requested');
const LOG = path.join(ARTIFACTS, 'observe.log');

fs.mkdirSync(ARTIFACTS, { recursive: true });
if (fs.existsSync(TRIGGER)) fs.rmSync(TRIGGER);

function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(' ')}`;
  fs.appendFileSync(LOG, `${line}\n`);
  console.log(line);
}

/** Runs inside one frame. Collects what a robust selector needs: accessible names, labels and
 *  every option of every dropdown. No guessing. */
function collectDom() {
  const labelFor = (el) => {
    if (el.id) {
      const explicit = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (explicit) return explicit.innerText.trim();
    }
    const wrapped = el.closest('label');
    if (wrapped) return wrapped.innerText.trim();
    return null;
  };

  const text = (el) => (el.innerText || el.textContent || '').trim().slice(0, 120);

  const controls = [...document.querySelectorAll('input,select,textarea')]
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type'),
      name: el.getAttribute('name'),
      id: el.id || null,
      role: el.getAttribute('role'),
      ariaLabel: el.getAttribute('aria-label'),
      label: labelFor(el),
      placeholder: el.getAttribute('placeholder'),
      autocomplete: el.getAttribute('autocomplete'),
      required: el.hasAttribute('required'),
      disabled: el.hasAttribute('disabled'),
      value: 'value' in el ? String(el.value).slice(0, 60) : null,
      options:
        el.tagName === 'SELECT'
          ? [...el.options].map((o) => ({ value: o.value, text: o.text.trim() }))
          : null,
      visible: !!(el.offsetParent || el.getClientRects().length),
    }))
    .filter((c) => c.visible);

  const buttons = [...document.querySelectorAll('button,[role="button"],a[href]')]
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      text: text(el),
      ariaLabel: el.getAttribute('aria-label'),
      type: el.getAttribute('type'),
      disabled: el.hasAttribute('disabled'),
      visible: !!(el.offsetParent || el.getClientRects().length),
    }))
    .filter((b) => b.visible && (b.text || b.ariaLabel))
    .slice(0, 250);

  const ariaWidgets = [
    ...document.querySelectorAll(
      '[role="combobox"],[role="listbox"],[role="option"],[role="radio"],[role="checkbox"],[role="switch"]',
    ),
  ]
    .map((el) => ({
      role: el.getAttribute('role'),
      text: text(el),
      ariaLabel: el.getAttribute('aria-label'),
      ariaChecked: el.getAttribute('aria-checked'),
      ariaExpanded: el.getAttribute('aria-expanded'),
    }))
    .slice(0, 250);

  const headings = [...document.querySelectorAll('h1,h2,h3,h4,legend,label')]
    .map((el) => ({ tag: el.tagName.toLowerCase(), text: text(el) }))
    .filter((h) => h.text)
    .slice(0, 200);

  return {
    url: location.href,
    title: document.title,
    counts: {
      inputs: controls.length,
      buttons: buttons.length,
      ariaWidgets: ariaWidgets.length,
    },
    headings,
    controls,
    buttons,
    ariaWidgets,
  };
}

const context = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: { width: 1440, height: 900 },
});

const first = context.pages()[0] ?? (await context.newPage());
if (first.url() === 'about:blank') {
  await first.goto('https://www.tiendanube.com/').catch(() => {});
}
log('browser open, profile:', PROFILE);

const seen = new Map();
let dumpCount = 0;

const tick = setInterval(async () => {
  try {
    for (const page of context.pages()) {
      for (const frame of page.frames()) {
        const key = `${page.url()} :: ${frame.url()}`;
        if (!seen.has(key)) {
          seen.set(key, true);
          log('frame', frame.url());
        }
      }
    }

    if (!fs.existsSync(TRIGGER)) return;

    const pages = context.pages();
    const page = pages[pages.length - 1];
    const frames = [];
    for (const frame of page.frames()) {
      try {
        frames.push({ frameName: frame.name(), ...(await frame.evaluate(collectDom)) });
      } catch (error) {
        frames.push({ frameUrl: frame.url(), error: error.message });
      }
    }

    dumpCount += 1;
    const file = path.join(ARTIFACTS, `dom-dump-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify({ pageUrl: page.url(), frames }, null, 2));
    fs.rmSync(TRIGGER);
    log('dump', String(dumpCount), '->', file, 'frames:', String(frames.length));
  } catch (error) {
    log('dump failed:', error.message);
  }
}, 1500);

context.on('close', () => {
  clearInterval(tick);
  log('browser closed');
  process.exit(0);
});

process.on('SIGINT', async () => {
  clearInterval(tick);
  await context.close();
});

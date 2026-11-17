/**
 * Structural guard for the irreversible actions of the Envío Nube journey.
 *
 * The rules this checks, and why a static check is worth having:
 *
 * - `Comprar` (and `Comprar etiqueta`) is the paying action. It may be referenced
 *   only for visibility assertions, so no source line may combine a `Comprar`
 *   reference with a `.click(` call, and no purchase helper may appear at all.
 * - `Crear envío` creates the shipment without charging. It is allowed now, but
 *   only inside the gated `createShipment(approval)` method, so the reference must
 *   stay in one file.
 *
 * This is a cheap regression guard against a future edit that "just adds a small
 * helper". It is not a proof of correctness; the nightly review reads the diff.
 *
 * Run: `npm run safety-guard`
 */
import fs from 'node:fs';
import path from 'node:path';

const EXECUTOR_DIR = path.resolve('src/executor');

const FORBIDDEN_IDENTIFIERS = [
  'buyLabel',
  'purchaseLabel',
  'createPurchase',
  'payLabel',
  'comprarEtiqueta',
  'comprarEtiquetaEnvioNube',
];

const failures = [];
const sources = [];

for (const entry of fs.readdirSync(EXECUTOR_DIR, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
  const file = path.join(EXECUTOR_DIR, entry.name);
  sources.push({ name: entry.name, source: fs.readFileSync(file, 'utf8') });
}

for (const { name, source } of sources) {
  for (const identifier of FORBIDDEN_IDENTIFIERS) {
    const pattern = new RegExp(`\\b${identifier}\\b`);
    if (pattern.test(source)) {
      failures.push(`${name}: forbidden purchase identifier "${identifier}"`);
    }
  }

  const lines = source.split('\n');
  for (const [index, text] of lines.entries()) {
    const mentionsComprar = /COMPRAR_BUTTON|COMPRAR_CARD|'Comprar'|"Comprar"|Comprar etiqueta/.test(text);
    if (mentionsComprar && /\.click\s*\(/.test(text)) {
      failures.push(`${name}:${index + 1}: a "Comprar" reference shares a line with a click: ${text.trim()}`);
    }
  }
}

const createReferences = sources
  .filter(({ source }) => /CREATE_BUTTON/.test(source))
  .map(({ name }) => name);
if (createReferences.length !== 1 || createReferences[0] !== 'envioNube.ts') {
  failures.push(
    `"Crear envío" (CREATE_BUTTON) must be referenced in exactly one module, envioNube.ts; found: ${createReferences.join(', ') || '(none)'}`,
  );
}

if (failures.length > 0) {
  console.error('FAIL: irreversible-action guard');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('OK: "Comprar" has no click path and "Crear envío" stays in the gated page object.');
}

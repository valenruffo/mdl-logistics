/**
 * The shared text normalizer and the copy matcher.
 *
 * These tests exist because of a real false negative: after a *successful*
 * creation the run aborted claiming the `Comprar etiqueta` card did not contain
 * `código de seguimiento`, comparing raw prose against the panel's own spelling.
 * Every string below is interface copy observed on the panel — not personal data.
 *
 * Offline and deterministic: no browser, no network, no file system.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collapseWhitespace,
  normalizeLookupKey,
  normalizeText,
  sameText,
  textContains,
} from '../../src/core/normalize';
import { copyPattern } from '../../src/executor/copy';

/** The `Comprar etiqueta` card copy, verbatim from the panel. */
const CARD_COPY = 'El código de seguimiento se generará automáticamente al imprimir la etiqueta';

// ------------------------------------------------------------- normalizeText

test('normalizeText collapses case, accents and whitespace into one comparison form', () => {
  const expected = 'el codigo de seguimiento se generara automaticamente al imprimir la etiqueta';

  assert.equal(normalizeText(CARD_COPY), expected);
  assert.equal(normalizeText(CARD_COPY.toUpperCase()), expected);
  assert.equal(normalizeText('  El   código\tde\nseguimiento se generará automáticamente al imprimir la etiqueta  '), expected);
  // Same copy with the accents typed away.
  assert.equal(
    normalizeText('El codigo de seguimiento se generara automaticamente al imprimir la etiqueta'),
    expected,
  );
});

test('normalizeText accepts decomposed accents, which is how a panel may render them', () => {
  const decomposed = CARD_COPY.normalize('NFD');
  assert.notEqual(decomposed, CARD_COPY, 'the NFD form must differ byte-for-byte');
  assert.equal(normalizeText(decomposed), normalizeText(CARD_COPY));
});

test('normalizeText keeps token separation: extra whitespace is presentation, not data', () => {
  assert.equal(normalizeText('Por enviar'), 'por enviar');
  assert.equal(normalizeText('  Por    enviar '), 'por enviar');
  assert.equal(normalizeText('Por\u00a0enviar'), 'por enviar', 'a non-breaking space is whitespace too');
  assert.notEqual(normalizeText('Por enviar'), normalizeText('Porenviar'));
});

test('sameText compares whole strings, normalized', () => {
  assert.equal(sameText('Por enviar', 'Por enviar'), true);
  assert.equal(sameText('Por enviar', 'POR ENVIAR'), true);
  assert.equal(sameText('  Por   enviar ', 'Por enviar'), true);
  assert.equal(sameText('Por enviar', 'Envío manual'), false);
  // Whole-string, not substring: a badge must not "match" a longer sentence.
  assert.equal(sameText('Por enviar', 'Por enviar el paquete'), false);
});

test('textContains is the normalized substring test', () => {
  assert.equal(textContains(CARD_COPY, 'código de seguimiento'), true);
  assert.equal(textContains(CARD_COPY, 'CODIGO DE SEGUIMIENTO'), true);
  assert.equal(textContains(CARD_COPY, 'imprimir la etiqueta'), true);
  assert.equal(textContains(CARD_COPY, 'código de entrega'), false);
  assert.equal(textContains('Comprar etiqueta', 'comprar'), true);
  assert.equal(textContains('Comprar', 'Comprar'), true);
});

test('the lookup key still strips dots on top of the shared normalization', () => {
  assert.equal(normalizeLookupKey('C.A.B.A.'), 'caba');
  assert.equal(normalizeLookupKey('Ciudad Autónoma de Buenos Aires (CABA)'), 'ciudad autonoma de buenos aires (caba)');
  assert.equal(normalizeLookupKey('CÓRDOBA'), normalizeLookupKey('Cordoba'));
  assert.equal(normalizeLookupKey(' a . b '), 'a b', 'no double space survives the dot strip');
  assert.equal(collapseWhitespace('  a   b '), 'a b');
});

// ---------------------------------------------------------------- copyPattern

/** True when the matcher accepts the candidate the panel could render. */
function matches(text: string, candidate: string, exact = false): boolean {
  return copyPattern(text, { exact }).test(candidate);
}

test('copyPattern accepts the panel copy in any case, accent shape or spacing', () => {
  for (const text of [
    'Comprar etiqueta',
    'COMPRAR ETIQUETA',
    'comprar etiqueta',
    '  Comprar   etiqueta ',
  ]) {
    assert.equal(matches('Comprar etiqueta', text), true, text);
  }
  for (const text of ['Envío manual', 'Envio manual', 'ENVÍO MANUAL', 'envio   manual']) {
    assert.equal(matches('Envío manual', text), true, text);
  }
  for (const text of ['Crear envío', 'crear envio', 'CREAR ENVÍO', 'Crear  envío']) {
    assert.equal(matches('Crear envío', text, true), true, text);
  }
});

test('copyPattern matches accented copy that the panel renders decomposed', () => {
  assert.equal(matches('código de seguimiento', 'co\u0301digo de seguimiento'), true);
  assert.equal(matches('código de seguimiento', 'CODIGO DE SEGUIMIENTO'), true);
});

test('copyPattern does not match different copy', () => {
  assert.equal(matches('Comprar etiqueta', 'Comprar'), false, 'substring match is one-directional');
  assert.equal(matches('Crear envío', 'Crear envío y comprar', true), false, 'exact is anchored');
  assert.equal(matches('Por enviar', 'Por pagar'), false);
});

test('copyPattern treats regex metacharacters as literal copy', () => {
  assert.equal(matches('#EM1054', '#EM1054'), true);
  assert.equal(matches('#EM1054', '#EM1053'), false);
  assert.equal(matches('Paso 4 de 4', 'Paso  4 de  4'), true);
  assert.equal(matches('Paso 4 de 4', 'Paso 44 de 44'), false);
  // A `(` in copy must never reach the regex engine unescaped.
  assert.doesNotThrow(() => copyPattern('Buenos Aires (CABA)'));
  assert.equal(matches('Buenos Aires (CABA)', 'buenos aires (caba)'), true);
});

test('copyPattern collapses consecutive whitespace in the source copy into one run', () => {
  assert.equal(matches('Por   enviar', 'Por enviar'), true);
  assert.equal(matches('Por   enviar', 'Por\t\nenviar'), true);
});

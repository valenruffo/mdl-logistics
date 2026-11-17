/**
 * The post-creation proof: "the label is still unpaid" (S12).
 *
 * This is a regression suite for a real false negative. A shipment `#EM1054` was
 * created (panel: `Envío creado con éxito`, `Por enviar`, the `Comprar etiqueta`
 * card and a `Comprar` button) and the run then aborted claiming the card "does
 * not contain `código de seguimiento`" — a case/accent mismatch against prose.
 * A created shipment reported as unverified is worse than no check at all.
 *
 * The proof is therefore structural, and these tests pin it:
 *  1. the heading matches `#EM<number>`,
 *  2. a visible button's accessible name contains `Comprar`,
 *  3. a badge reads `Por enviar`.
 *
 * The card's prose is informational only. Every string here is interface copy
 * observed on the panel; no personal data is involved. Offline, no browser.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { ShipmentDetailReadback } from '../../src/executor/envioNube';
import {
  COMPRAR_BUTTON,
  COMPRAR_CARD,
  DETAIL_CARDS,
  SHIPMENT_ID_PATTERN,
  UNPAID_LABEL_CHECKS,
  UNPAID_STATUS_BADGE,
  labelUnpaidProblem,
  unpaidLabelFailures,
} from '../../src/executor/envioNube';

/** The `Comprar etiqueta` card copy, verbatim from the panel. */
const CARD_COPY = 'El código de seguimiento se generará automáticamente al imprimir la etiqueta';

/** The detail page exactly as the operator saw it after a real creation. */
function realDetail(patch: Partial<ShipmentDetailReadback> = {}): ShipmentDetailReadback {
  return {
    url: 'https://services-ne-app-front-ar.nuvemshop.com.br/shipping-details/1234',
    shipmentId: '#EM1054',
    shipmentIdHeading: '#EM1054',
    statusBadges: [UNPAID_STATUS_BADGE, 'Envío manual'],
    badgeTexts: [UNPAID_STATUS_BADGE, 'Envío manual'],
    cards: [
      { title: COMPRAR_CARD, present: true, text: CARD_COPY },
      { title: DETAIL_CARDS[1] ?? 'Datos del envío', present: true, text: 'Andreani a domicilio' },
      { title: DETAIL_CARDS[2] ?? 'Más información', present: true, text: 'Datos del destinatario' },
    ],
    buyCardText: CARD_COPY,
    buttonNames: ['Comprar etiqueta', 'Imprimir'],
    buyButtonVisible: true,
    bodyText: `#EM1054 Envío creado con éxito ${UNPAID_STATUS_BADGE} ${COMPRAR_CARD} ${CARD_COPY} Comprar`,
    ...patch,
  };
}

const CHECK_NAMES = UNPAID_LABEL_CHECKS.map(({ check }) => check);
const FAILING_TEXT = /does not prove the label is unpaid/;

// ------------------------------------------------------- the proof itself

test('the three structural checks are the whole proof, in a fixed order', () => {
  assert.deepEqual(CHECK_NAMES, ['shipmentId', 'statusBadge', 'buyButton']);
  // The prose is never one of the checks.
  for (const { requirement } of UNPAID_LABEL_CHECKS) {
    assert.doesNotMatch(requirement, /seguimiento|imprimir la etiqueta/i);
  }
});

test('the real detail page passes: id, badge and Comprar present', () => {
  assert.deepEqual(unpaidLabelFailures(realDetail()), []);
  assert.equal(labelUnpaidProblem(realDetail()), null);
});

test('a different case in every string still passes', () => {
  const casing = realDetail({
    shipmentIdHeading: '#em1054',
    badgeTexts: ['POR ENVIAR', 'envio manual'],
    buttonNames: ['COMPRAR ETIQUETA'],
  });

  assert.deepEqual(unpaidLabelFailures(casing), []);
  assert.equal(labelUnpaidProblem(casing), null);
});

test('missing accents still pass', () => {
  // The panel's copy is accented; a rendering without accents is the same state.
  assert.deepEqual(unpaidLabelFailures(realDetail({ badgeTexts: ['Por enviár'] })), []);
  assert.deepEqual(unpaidLabelFailures(realDetail({ buttonNames: ['Comprar etiquéta'] })), []);
});

test('extra whitespace still passes', () => {
  const spaced = realDetail({
    shipmentIdHeading: '  #EM1054 ',
    badgeTexts: ['  Por    enviar\n'],
    buttonNames: ['  Comprar   etiqueta '],
  });

  assert.deepEqual(unpaidLabelFailures(spaced), []);
  assert.equal(labelUnpaidProblem(spaced), null);
});

test('a badge carrying decoration beside its words still passes', () => {
  // A badge node can hold a date or an icon label; that is not a different state.
  assert.deepEqual(unpaidLabelFailures(realDetail({ badgeTexts: ['Por enviar · 12/03'] })), []);
  assert.deepEqual(unpaidLabelFailures(realDetail({ badgeTexts: ['ETIQUETA: POR ENVIAR'] })), []);
});

test('the card prose is informational: a reworded card never fails the proof', () => {
  // This is the exact bug: prose was the assertion, so real copy failed it.
  const reworded = realDetail({
    buyCardText: 'Etiqueta sin pagar',
    cards: [{ title: COMPRAR_CARD, present: true, text: 'Etiqueta sin pagar' }],
  });
  assert.equal(labelUnpaidProblem(reworded), null);

  // And an empty card text cannot fail the proof either.
  assert.equal(labelUnpaidProblem(realDetail({ buyCardText: null })), null);
});

test('the shipment id is structural, not decoration', () => {
  assert.match('#EM1054', SHIPMENT_ID_PATTERN);
  assert.match('#em1054', SHIPMENT_ID_PATTERN);
  assert.doesNotMatch('#1054', SHIPMENT_ID_PATTERN);

  const noId = unpaidLabelFailures(realDetail({ shipmentIdHeading: null }));
  assert.deepEqual(noId.map((failure) => failure.check), ['shipmentId']);
  assert.match(noId[0]?.observed ?? '', /no heading was read/);

  const wrongShape = unpaidLabelFailures(realDetail({ shipmentIdHeading: 'EM1054' }));
  assert.deepEqual(wrongShape.map((failure) => failure.check), ['shipmentId']);
  assert.match(wrongShape[0]?.observed ?? '', /EM1054/);
});

// ------------------------------------------------- the genuinely failing case

test('no Comprar button fails the proof, and the error names the button check', () => {
  const detail = realDetail({
    buttonNames: ['Cancelar', 'Volver'],
    buyButtonVisible: false,
  });

  const failures = unpaidLabelFailures(detail);
  assert.deepEqual(failures.map((failure) => failure.check), ['buyButton']);
  assert.match(failures[0]?.requirement ?? '', /Comprar/);
  // The observations are the real values, not a prose substring.
  assert.match(failures[0]?.observed ?? '', /"Cancelar"/);
  assert.match(failures[0]?.observed ?? '', /"Volver"/);

  const problem = labelUnpaidProblem(detail);
  assert.ok(problem !== null, 'a missing Comprar button must fail');
  assert.match(problem.message, FAILING_TEXT);
  assert.match(problem.message, /1 of 3 structural checks failed \(buyButton\)/);
  assert.match(problem.message, /"Cancelar"/, 'the message prints the buttons actually found');
  assert.match(problem.message, /"Por enviar"/, 'the message prints the badge actually found');
  assert.match(problem.message, /"#EM1054"/, 'the message prints the heading actually found');
  // The failing check is spelled out, with what was read.
  const buyLine = problem.details.find((detail_) => detail_.includes('buyButton'));
  assert.ok(buyLine !== undefined);
  assert.match(buyLine, /^  FAIL buyButton:/);
  assert.match(buyLine, /"Cancelar"/);
});

test('a badge that is not Por enviar fails the proof and names the badge check', () => {
  const detail = realDetail({ badgeTexts: ['Pagado', 'Envío manual'] });
  const failures = unpaidLabelFailures(detail);

  assert.deepEqual(failures.map((failure) => failure.check), ['statusBadge']);
  assert.match(failures[0]?.observed ?? '', /"Pagado"/);

  const problem = labelUnpaidProblem(detail);
  assert.ok(problem !== null);
  assert.match(problem.message, /\(statusBadge\)/);
  assert.match(problem.message, /"Pagado"/);
  // Still prints the two checks that did hold.
  assert.match(problem.message, /"Comprar etiqueta"/);
});

test('an empty badge list fails, and says that nothing was read', () => {
  const failures = unpaidLabelFailures(realDetail({ badgeTexts: [] }));
  assert.deepEqual(failures.map((failure) => failure.check), ['statusBadge']);
  assert.match(failures[0]?.observed ?? '', /\(none\)/);
});

test('all three checks can fail at once and every one is named', () => {
  const detail = realDetail({
    shipmentId: '',
    shipmentIdHeading: null,
    badgeTexts: [],
    buttonNames: [],
    buyButtonVisible: false,
  });

  const failures = unpaidLabelFailures(detail);
  assert.deepEqual(failures.map((failure) => failure.check), ['shipmentId', 'statusBadge', 'buyButton']);

  const problem = labelUnpaidProblem(detail);
  assert.ok(problem !== null);
  assert.match(problem.message, /3 of 3 structural checks failed \(shipmentId, statusBadge, buyButton\)/);
  assert.equal(problem.details.filter((line) => line.startsWith('  FAIL ')).length, 3);
  assert.equal(problem.details.filter((line) => line.startsWith('  PASS ')).length, 0);
});

test('the details carry every check, the informational copy and the id', () => {
  const problem = labelUnpaidProblem(realDetail({ buttonNames: ['Comprar'], badgeTexts: ['Por pagar'] }));
  assert.ok(problem !== null);

  assert.ok(problem.details.some((line) => line === 'shipment id: #EM1054'));
  assert.ok(problem.details.some((line) => line.startsWith('  PASS shipmentId:')));
  assert.ok(problem.details.some((line) => line.startsWith('  FAIL statusBadge:')));
  assert.ok(problem.details.some((line) => line.startsWith('  PASS buyButton:')));
  const informational = problem.details.find((line) => line.includes('informational only'));
  assert.ok(informational !== undefined, 'the card copy is kept as information');
  assert.match(informational, /generará automáticamente/);
});

test('Comprar is a substring of the accessible name, so a labelled button counts', () => {
  assert.deepEqual(unpaidLabelFailures(realDetail({ buttonNames: ['Comprar etiqueta'] })), []);
  assert.deepEqual(unpaidLabelFailures(realDetail({ buttonNames: ['Comprar'] })), []);
  assert.equal(unpaidLabelFailures(realDetail({ buttonNames: ['Comprobante'] })).length, 1);
});

test('the exported button and card names are the panel copy', () => {
  assert.equal(COMPRAR_BUTTON, 'Comprar');
  assert.equal(COMPRAR_CARD, 'Comprar etiqueta');
  assert.equal(UNPAID_STATUS_BADGE, 'Por enviar');
});

/**
 * The branch matching rule against the **real Jujuy live-failure data** (R11:
 * offline, deterministic, interface copy only — no personal data).
 *
 * The live failure: the operator pasted `Sucursal (nombre): Gral. San Martin
 * 979 San Salvador de Jujuy` with CP 4800. The panel's dropdown offered 13
 * options for that CP, including exactly
 * `"Sucursal - Gral. San Martin 979 San Salvador de Jujuy, Jujuy"` — the same
 * branch, decorated with a `Sucursal - ` prefix and a trailing `, Jujuy`. The
 * exact-text matcher rejected it and the run aborted listing all 13 options.
 *
 * Option 1 below is the observed option text **verbatim**; the remaining
 * twelve are representative decorated forms of the same dropdown shape (the
 * panel's CP 4800 list as observed: one `Punto Andreani Hop` point among plain
 * `Sucursal - ` rows, each ending in the repeated city name). The point of the
 * fixture is the decoration asymmetry, not the exact other twelve rows.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  branchIdentity,
  parseStreetNumberPair,
} from '../../src/executor/branch';
import { matchSucursalBranch, type BranchOption } from '../../src/executor/envioNube';

/** The observed live failure's dropdown for CP 4800 (13 options), UUID values stand in. */
const JUJUY_OPTIONS: readonly BranchOption[] = [
  { index: 1, value: 'uuid-jujuy-01', text: 'Sucursal - Gral. San Martin 979 San Salvador de Jujuy, Jujuy' },
  { index: 2, value: 'uuid-jujuy-02', text: 'Sucursal - Batalla de Salta 350 San Salvador de Jujuy, Jujuy' },
  { index: 3, value: 'uuid-jujuy-03', text: 'Sucursal - Corrientes 580 San Salvador de Jujuy, Jujuy' },
  { index: 4, value: 'uuid-jujuy-04', text: 'Sucursal - Alberdi 235 San Salvador de Jujuy, Jujuy' },
  { index: 5, value: 'uuid-jujuy-05', text: 'Sucursal - Sarmiento 442 San Salvador de Jujuy, Jujuy' },
  { index: 6, value: 'uuid-jujuy-06', text: 'Sucursal - Independencia 61 San Salvador de Jujuy, Jujuy' },
  { index: 7, value: 'uuid-jujuy-07', text: 'Sucursal - Lamadrid 226 San Salvador de Jujuy, Jujuy' },
  { index: 8, value: 'uuid-jujuy-08', text: 'Sucursal - Nicasio Sacetta 480 San Salvador de Jujuy, Jujuy' },
  { index: 9, value: 'uuid-jujuy-09', text: 'Punto Andreani Hop - Av. Europa 150, San Salvador de Jujuy, Jujuy' },
  { index: 10, value: 'uuid-jujuy-10', text: 'Punto Andreani Hop - Cantera 145, Palpalá, Jujuy' },
  { index: 11, value: 'uuid-jujuy-11', text: 'Sucursal - Av. 19 de Abril 342, Perico, Jujuy' },
  { index: 12, value: 'uuid-jujuy-12', text: 'Sucursal - Ruta 9 km 33, El Carmen, Jujuy' },
  { index: 13, value: 'uuid-jujuy-13', text: 'Sucursal - Belgrano 150, San Pedro, Jujuy' },
];

test('the live Jujuy failure: the pasted bare name uniquely matches the decorated option by street+number', () => {
  // The operator's pasted customer line, verbatim (no `Sucursal - ` prefix, no
  // trailing city) against the full 13-option decorated dropdown.
  const match = matchSucursalBranch('Gral. San Martin 979 San Salvador de Jujuy', JUJUY_OPTIONS);
  assert.equal(match.kind, 'unique', 'exactly one option contains the street+number pair');
  if (match.kind !== 'unique') throw new Error('unreachable');
  assert.equal(match.rule, 'street-number-pair');
  assert.equal(match.option.value, 'uuid-jujuy-01');
  assert.equal(
    match.option.text,
    'Sucursal - Gral. San Martin 979 San Salvador de Jujuy, Jujuy',
    'the selected text is the panel’s own decorated spelling',
  );

  // The decorated form itself (what the panel would echo back) matches the same
  // option: prefix and trailing city are decoration, never identity.
  const decorated = matchSucursalBranch('Sucursal - Gral. San Martin 979 San Salvador de Jujuy, Jujuy', JUJUY_OPTIONS);
  assert.equal(decorated.kind, 'unique');
  if (decorated.kind !== 'unique') throw new Error('unreachable');
  assert.equal(decorated.option.value, 'uuid-jujuy-01');
});

test('the parsed pair is (street AND number); decorative tokens never participate', () => {
  const pair = parseStreetNumberPair('Gral. San Martin 979 San Salvador de Jujuy');
  assert.deepEqual(pair, { street: 'gral san martin', number: '979' });

  // The panel's decorated option text parses to the same identity.
  const decorated = parseStreetNumberPair('Sucursal - Gral. San Martin 979 San Salvador de Jujuy, Jujuy');
  assert.deepEqual(decorated, { street: 'gral san martin', number: '979' }, 'the `Sucursal - ` prefix and trailing `, Jujuy` are stripped');

  // The pair identity of both spellings is one string: what the approval hash
  // and the readback diff compare.
  assert.equal(
    branchIdentity('Gral. San Martin 979 San Salvador de Jujuy'),
    branchIdentity('Sucursal - Gral. San Martin 979 San Salvador de Jujuy, Jujuy'),
  );
  // ...and two branches on the same street with different numbers never share it.
  assert.notEqual(branchIdentity('San Martin 979'), branchIdentity('San Martin 1327'));
});

test('a name whose street+number pair matches nothing is a rejection listing all 13 options', () => {
  const match = matchSucursalBranch('Rivadavia 9999 San Salvador de Jujuy', JUJUY_OPTIONS);
  assert.equal(match.kind, 'none', 'zero candidates → rejection, never a guess');
  if (match.kind !== 'none') throw new Error('unreachable');
  assert.equal(match.rule, 'street-number-pair');
  assert.equal(match.reason, 'no-option-contains-street');
  assert.equal(match.options.length, 13, 'the rejection carries the real option list (R12)');
  assert.ok(
    match.options.some((option) => option.text === 'Sucursal - Gral. San Martin 979 San Salvador de Jujuy, Jujuy'),
    'the observed option is among the listed ones',
  );
});

test('the live Jujuy CP-4600 failure: a street mention inside another option entre-calles text is never a candidate', () => {
  // The real dropdown texts observed for CP 4600, verbatim. Option 2's own
  // street is Lamadrid 177; `gral san martin` appears only inside its
  // `entre calles` description — counting it as a same-street candidate
  // produced a false ambiguity that blocked the real shipment.
  const options: readonly BranchOption[] = [
    { index: 0, value: 'uuid-4600-real', text: 'Jujuy (Centro) - Gral. San Martín, 979, San Salvador De Jujuy, Jujuy' },
    { index: 1, value: 'uuid-4600-hop', text: 'Punto Andreani Hop Lamadrid 177 - Lamadrid, 177 Entrecalles gral san martin e independencia, San Salvador De Jujuy, Jujuy' },
  ];
  const match = matchSucursalBranch('Gral. San Martin 979 San Salvador de Jujuy', options);
  assert.equal(match.kind, 'unique', 'the entre-calles mention is not a candidate; the real branch is pinned alone');
  if (match.kind !== 'unique') throw new Error('unreachable');
  assert.equal(match.rule, 'street-number-pair');
  assert.equal(match.option.value, 'uuid-4600-real', 'the real branch — not the Hop point that merely mentions the street');
  assert.equal(match.option.text, 'Jujuy (Centro) - Gral. San Martín, 979, San Salvador De Jujuy, Jujuy');
});

test('two options carrying the identical street+number pair are genuinely ambiguous; different numbers on the same street are not', () => {
  // Genuinely ambiguous: two options with the SAME pair — co-located duplicate
  // points. Rejection is the safe behavior.
  const duplicated: readonly BranchOption[] = [
    { index: 0, value: 'uuid-a', text: 'Sucursal - Gral. San Martin 979, Jujuy' },
    { index: 1, value: 'uuid-b', text: 'Punto Andreani Hop - Gral. San Martin 979, Jujuy' },
    { index: 2, value: 'uuid-c', text: 'Sucursal - Corrientes 580, Jujuy' },
  ];
  const ambiguous = matchSucursalBranch('Gral. San Martin 979', duplicated);
  assert.equal(ambiguous.kind, 'ambiguous', 'two options with the identical pair are a real ambiguity; both are reported');
  if (ambiguous.kind !== 'ambiguous') throw new Error('unreachable');
  assert.equal(ambiguous.rule, 'street-number-pair');
  assert.equal(ambiguous.reason, 'street-shared-by-multiple-options');
  assert.deepEqual(
    ambiguous.matches.map((option) => option.value),
    ['uuid-a', 'uuid-b'],
  );

  // Different numbers are different pairs: `979` pins exactly one option —
  // never an ambiguity, never a rejection.
  const distinct: readonly BranchOption[] = [
    { index: 0, value: 'uuid-a', text: 'Sucursal - Gral. San Martin 979, Jujuy' },
    { index: 1, value: 'uuid-b', text: 'Sucursal - Gral. San Martin 1327, Jujuy' },
    { index: 2, value: 'uuid-c', text: 'Sucursal - Corrientes 580, Jujuy' },
  ];
  const unique = matchSucursalBranch('Gral. San Martin 979', distinct);
  assert.equal(unique.kind, 'unique', 'the number disambiguates same-street branches with different numbers');
  if (unique.kind !== 'unique') throw new Error('unreachable');
  assert.equal(unique.rule, 'street-number-pair');
  assert.equal(unique.option.value, 'uuid-a');
});

test('no number in the approved name: the full-text fallback decides', () => {
  // A customer wrote only the branch name, with no street number: the pair
  // cannot be parsed, so the exact-text rule applies.
  const unique = matchSucursalBranch('Sucursal Centro', [
    { index: 0, value: 'uuid-centro', text: 'Sucursal Centro' },
    { index: 1, value: 'uuid-norte', text: 'Sucursal Norte' },
  ]);
  assert.equal(unique.kind, 'unique');
  if (unique.kind !== 'unique') throw new Error('unreachable');
  assert.equal(unique.rule, 'full-text');

  // A bare carrier/point name that overlaps two options is still a rejection,
  // with both near matches reported.
  const hop = matchSucursalBranch('Punto Andreani Hop', JUJUY_OPTIONS);
  assert.equal(hop.kind, 'none', 'two Hop options contain the request, so nothing is selected');
  if (hop.kind !== 'none') throw new Error('unreachable');
  assert.equal(hop.rule, 'full-text', 'no pair could be parsed, so the fallback decided');
  assert.deepEqual(
    hop.nearMatches.map((option) => option.value),
    ['uuid-jujuy-09', 'uuid-jujuy-10'],
  );
});

test('a street-only match with a different number never selects — the pair is (street AND number)', () => {
  // `Balbin 1327`-style guard: the street matches but the number differs.
  const options: readonly BranchOption[] = [
    { index: 0, value: 'uuid-1327', text: 'Sucursal - Gral. San Martin 1327, Jujuy' },
    { index: 1, value: 'uuid-otro', text: 'Sucursal - Corrientes 580, Jujuy' },
  ];
  const match = matchSucursalBranch('Gral. San Martin 979', options);
  assert.equal(match.kind, 'none', 'street-only match, number differs → rejection');
  if (match.kind !== 'none') throw new Error('unreachable');
  assert.equal(match.rule, 'street-number-pair');
  assert.equal(match.reason, 'street-without-number');
  assert.deepEqual(match.nearMatches.map((option) => option.value), ['uuid-1327'], 'the near match is reported, never selected');

  // A number that only contains the approved number as a substring (`9790`
  // contains `979`) is a different number as a token: no match.
  const substring = matchSucursalBranch('Gral. San Martin 979', [
    { index: 0, value: 'uuid-9790', text: 'Sucursal - Gral. San Martin 9790, Jujuy' },
  ]);
  assert.equal(substring.kind, 'none', '979 ≠ 9790: the number must match as a whole token');
});

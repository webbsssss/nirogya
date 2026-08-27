/**
 * Voice input test: spoken numbers and yes/no must parse to the RIGHT value.
 *
 *   node tests/voice_test.mjs
 *
 * WHY THIS EXISTS. A mic that mishears is obvious and harmless — the ASHA sees
 * the wrong word and retypes. A mic that hears correctly and then PARSES wrong
 * is silent, and it writes a plausible number into a clinical record. Both of
 * these were live bugs:
 *
 *   ನಲವತ್ತೆರಡು  (age 42)  parsed as 40   -- every compound 21-99 lost its unit
 *   ಹದಿನಾಲ್ಕು   (14)      parsed as 4    -- the teen contains the unit word
 *   "two hundred" (FBS 200, frank diabetes) parsed as 102 -- a NORMAL reading
 *   "constructor"         parsed as a string, straight into a numeric field
 *
 * The last one is the reason the lookup tables are Maps: `tok in {...}` walks the
 * prototype chain, so any transcript containing "constructor" or "hasOwnProperty"
 * returned a Function.
 *
 * Two independent checks below, deliberately not sharing a source of truth:
 *   1. REFERENCE  — hand-written Kannada numerals, so the table is real Kannada.
 *   2. EXHAUSTIVE — every generated form round-trips, so nothing is shadowed.
 */

import {
  parseSpokenNumber, parseSpokenYesNo, KANNADA_NUMERALS,
  LANG_CHAIN, VoiceError, WebSpeechProvider, pickProvider,
} from '../web/js/voice.js';

let failures = 0;
const groups = new Map();

// JSON.stringify renders Infinity, NaN and null all as "null", which turns a
// real failure into "got null, want null". Show the type instead.
const show = (v) => (typeof v === 'string' ? JSON.stringify(v) : `${String(v)} (${typeof v})`);

function check(group, label, got, want) {
  const ok = Object.is(got, want);
  groups.set(group, (groups.get(group) || 0) + 1);
  if (!ok) {
    failures++;
    if (failures <= 20) {
      console.error(`\n  FAIL #${failures}  [${group}]  ${label}`);
      console.error(`    got  ${show(got)}`);
      console.error(`    want ${show(want)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 1. REFERENCE: hand-written Kannada numerals.
//    0-29 in full (that is where the teen/unit nesting hazards live), every
//    multiple of ten, a spread of compounds, and the hundreds used by FBS/BP.
// ---------------------------------------------------------------------------
const REFERENCE = [
  ['ಸೊನ್ನೆ', 0], ['ಒಂದು', 1], ['ಎರಡು', 2], ['ಮೂರು', 3], ['ನಾಲ್ಕು', 4],
  ['ಐದು', 5], ['ಆರು', 6], ['ಏಳು', 7], ['ಎಂಟು', 8], ['ಒಂಬತ್ತು', 9],
  ['ಹತ್ತು', 10], ['ಹನ್ನೊಂದು', 11], ['ಹನ್ನೆರಡು', 12], ['ಹದಿಮೂರು', 13],
  ['ಹದಿನಾಲ್ಕು', 14], ['ಹದಿನೈದು', 15], ['ಹದಿನಾರು', 16], ['ಹದಿನೇಳು', 17],
  ['ಹದಿನೆಂಟು', 18], ['ಹತ್ತೊಂಬತ್ತು', 19],
  ['ಇಪ್ಪತ್ತು', 20], ['ಇಪ್ಪತ್ತೊಂದು', 21], ['ಇಪ್ಪತ್ತೆರಡು', 22], ['ಇಪ್ಪತ್ತಮೂರು', 23],
  ['ಇಪ್ಪತ್ತನಾಲ್ಕು', 24], ['ಇಪ್ಪತ್ತೈದು', 25], ['ಇಪ್ಪತ್ತಾರು', 26], ['ಇಪ್ಪತ್ತೇಳು', 27],
  ['ಇಪ್ಪತ್ತೆಂಟು', 28], ['ಇಪ್ಪತ್ತೊಂಬತ್ತು', 29],
  ['ಮೂವತ್ತು', 30], ['ಮೂವತ್ತೈದು', 35],
  ['ನಲವತ್ತು', 40], ['ನಲವತ್ತೆರಡು', 42], ['ನಲವತ್ತೇಳು', 47],
  ['ಐವತ್ತು', 50], ['ಐವತ್ತಾರು', 56],
  ['ಅರವತ್ತು', 60], ['ಅರವತ್ತಮೂರು', 63], ['ಅರವತ್ತೈದು', 65],
  ['ಎಪ್ಪತ್ತು', 70], ['ಎಪ್ಪತ್ತೊಂದು', 71], ['ಎಪ್ಪತ್ತೆಂಟು', 78],
  ['ಎಂಬತ್ತು', 80], ['ಎಂಬತ್ತನಾಲ್ಕು', 84], ['ಎಂಬತ್ತೊಂಬತ್ತು', 89],
  ['ತೊಂಬತ್ತು', 90], ['ತೊಂಬತ್ತೆರಡು', 92], ['ತೊಂಬತ್ತೊಂಬತ್ತು', 99],
  ['ನೂರು', 100], ['ನೂರ ಹತ್ತು', 110], ['ನೂರ ಇಪ್ಪತ್ತು', 120],
  ['ನೂರ ಇಪ್ಪತ್ತಾರು', 126], ['ನೂರ ನಲವತ್ತು', 140],
  ['ಇನ್ನೂರು', 200], ['ಇನ್ನೂರ ಐವತ್ತು', 250], ['ಮುನ್ನೂರು', 300],
];
for (const [word, want] of REFERENCE) {
  check('kannada reference', word, parseSpokenNumber(word), want);
}

// The specific shadowing pairs. A teen must never resolve to the unit it
// contains, in either reading order.
for (const [teen, unit] of [['ಹದಿಮೂರು', 3], ['ಹದಿನಾಲ್ಕು', 4], ['ಹತ್ತೊಂಬತ್ತು', 9], ['ಹದಿನೈದು', 5]]) {
  const got = parseSpokenNumber(teen);
  check('shadowing', `${teen} must not collapse to ${unit}`, got === unit ? `collapsed to ${unit}` : 'distinct', 'distinct');
}

// ---------------------------------------------------------------------------
// 2. EXHAUSTIVE: every generated form must round-trip.
//    This is the check that scales — it proves no key in the whole 0-99 table is
//    shadowed by a shorter key it happens to contain.
// ---------------------------------------------------------------------------
let covered = 0;
for (const [word, value] of KANNADA_NUMERALS) {
  check('kannada exhaustive', word, parseSpokenNumber(word), value);
  covered++;
}
const values = new Set(KANNADA_NUMERALS.values());
for (let n = 0; n <= 99; n++) {
  if (!values.has(n)) { check('kannada coverage', `no word form for ${n}`, false, true); }
}

// ---------------------------------------------------------------------------
// 3. Digits — Kannada and ASCII, the common ASR output.
// ---------------------------------------------------------------------------
const DIGITS = [
  ['೪೨', 42], ['೧೨೦', 120], ['42', 42], ['82.5', 82.5],
  ['ವಯಸ್ಸು ೪೫', 45], ['sugar 210', 210], ['೮೨ ಸೆಂ.ಮೀ', 82],
];
for (const [word, want] of DIGITS) check('digits', word, parseSpokenNumber(word), want);

// ---------------------------------------------------------------------------
// 4. English words, including multiplicative hundred.
// ---------------------------------------------------------------------------
const ENGLISH = [
  ['forty two', 42], ['fourty two', 42], ['ninety nine', 99], ['zero', 0],
  ['two hundred', 200], ['one hundred forty', 140], ['one hundred and forty', 140],
  ['three hundred', 300], ['sixty five', 65], ['eighteen', 18],
  ['hundred', null], ['blah', null], [' ', null], ['', null],
];
for (const [word, want] of ENGLISH) check('english', JSON.stringify(word), parseSpokenNumber(word), want);

// ---------------------------------------------------------------------------
// 5. Prototype keys must never parse. Maps, not object literals.
// ---------------------------------------------------------------------------
for (const key of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf']) {
  check('prototype safety', key, parseSpokenNumber(key), null);
}
// A prototype key ALONE is also caught by the finite-value guard, so it cannot
// distinguish a Map lookup from an object literal. These can: a real number
// beside a prototype word must still parse, which only holds if the lookup
// ignores inherited keys instead of returning a Function and poisoning the sum.
check('prototype safety', 'one + constructor still parses as 1', parseSpokenNumber('one constructor'), 1);
check('prototype safety', 'forty two + __proto__ still parses as 42', parseSpokenNumber('forty two __proto__'), 42);

// ---------------------------------------------------------------------------
// 6. Plausibility range. An out-of-range value must be refused, not stored.
// ---------------------------------------------------------------------------
const AGE = { min: 1, max: 120 };
const WAIST = { min: 30, max: 200 };
const FBS = { min: 20, max: 600 };
check('range', 'age 42 accepted', parseSpokenNumber('42', AGE), 42);
check('range', 'age 420 refused', parseSpokenNumber('420', AGE), null);
check('range', 'age 0 refused', parseSpokenNumber('0', AGE), null);
check('range', 'waist 82 accepted', parseSpokenNumber('82', WAIST), 82);
check('range', 'waist 8200 refused', parseSpokenNumber('8200', WAIST), null);
check('range', 'FBS 250 accepted', parseSpokenNumber('250', FBS), 250);
check('range', 'FBS 2500 refused', parseSpokenNumber('2500', FBS), null);
check('range', 'Kannada 42 in age range', parseSpokenNumber('ನಲವತ್ತೆರಡು', AGE), 42);
check('range', 'no range = no limit', parseSpokenNumber('8200'), 8200);

// ---------------------------------------------------------------------------
// 7. Nothing-to-parse must be null, never NaN or a string. `if (v == null)` is
//    the caller's only guard, and NaN slips straight through it.
// ---------------------------------------------------------------------------
for (const v of [null, undefined, '', '   ', 'ಹೌದು', 'namaskara']) {
  check('null safety', JSON.stringify(v), parseSpokenNumber(v), null);
}
// A long digit run overflows to Infinity in parseFloat. Infinity is a number and
// passes a bare `v == null` check, so it must be rejected here.
check('null safety', '400-digit run must not return Infinity', parseSpokenNumber('9'.repeat(400)), null);

// ---------------------------------------------------------------------------
// 8. Yes/no.
// ---------------------------------------------------------------------------
const YESNO = [
  ['ಹೌದು', true], ['ಹೂಂ', true], ['yes', true], ['Yes please', true], ['yep', true],
  ['ಇಲ್ಲ', false], ['no', false], ['No', false], ['nope', false],
  ['ಹೌದು ಇಲ್ಲ', false], ['maybe', null], ['', null], [null, null], ['42', null],
];
for (const [word, want] of YESNO) check('yes/no', JSON.stringify(word), parseSpokenYesNo(word), want);

// ---------------------------------------------------------------------------
// 9. Provider contract. No microphone in Node, so assert the shape and that a
//    headless environment degrades to a typed VoiceError instead of throwing
//    something unrecognisable at the UI.
// ---------------------------------------------------------------------------
const p = pickProvider();
check('provider', 'pickProvider returns a provider', typeof p.listen, 'function');
check('provider', 'unavailable without window', new WebSpeechProvider().available, false);
check('provider', 'lang chain starts with Kannada', LANG_CHAIN[0], 'kn-IN');
check('provider', 'lang chain has a fallback', LANG_CHAIN.length > 1, true);
try {
  await new WebSpeechProvider().listen({ lang: 'kn-IN' });
  check('provider', 'headless listen must reject', 'resolved', 'rejected');
} catch (e) {
  check('provider', 'rejects with VoiceError', e instanceof VoiceError, true);
  check('provider', 'error carries a code', e.code, 'unsupported');
  check('provider', 'error carries readable help', e.message.length > 20, true);
}

// ---------------------------------------------------------------------------
const total = [...groups.values()].reduce((a, b) => a + b, 0);
console.log(`\nVoice parsing: ${total} assertions across ${groups.size} groups`);
for (const [g, n] of groups) console.log(`  ${String(n).padStart(4)}  ${g}`);
console.log(`  Kannada word forms covered: ${covered} (0-99 complete)`);

if (failures) {
  console.error(`\n${failures} FAILURE(S). A wrong number here reaches a clinical record silently.`);
  process.exit(1);
}
console.log('VOICE OK — spoken numbers and yes/no parse correctly.\n');

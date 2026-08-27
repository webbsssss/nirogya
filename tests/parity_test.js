/**
 * Parity test: web/js/risk.js must score IDENTICALLY to server/risk.py.
 *
 *   python3 tests/gen_parity_cases.py > tests/parity_cases.json
 *   node tests/parity_test.js
 *
 * WHY THIS EXISTS. The phone scores offline with risk.js; the server scores with
 * risk.py. If they disagree, the risk band a judge sees on the phone changes when
 * it syncs — live, in front of them. That is an unrecoverable demo failure and it
 * is completely preventable, so it is tested.
 *
 * Compares: CBAC score + every item, IDRS score + every item, band, refer,
 * referral reason strings, raw probabilities to 1e-12, and the top-3 driver
 * explanation strings verbatim.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setWeights, assess } from '../web/js/risk.js';

const here = dirname(fileURLToPath(import.meta.url));
const weights = JSON.parse(readFileSync(join(here, '..', 'web', 'data', 'model_weights.json'), 'utf8'));
setWeights(weights);

const { n, cases } = JSON.parse(readFileSync(join(here, 'parity_cases.json'), 'utf8'));

const TOL = 1e-12;
let failures = 0;
const seen = { HIGH: 0, MODERATE: 0, LOW: 0 };
const shown = new Set();

function fail(i, what, got, want, patient) {
  failures++;
  if (failures <= 12) {
    console.error(`\n  FAIL #${failures}  case ${i}  [${what}]`);
    console.error(`    got  ${JSON.stringify(got)}`);
    console.error(`    want ${JSON.stringify(want)}`);
    console.error(`    patient ${JSON.stringify(patient)}`);
  }
  shown.add(what);
}

for (let i = 0; i < cases.length; i++) {
  const { patient, expected } = cases[i];
  const got = assess(patient);
  seen[got.risk_band]++;

  if (got.cbac_score !== expected.cbac_score) fail(i, 'cbac_score', got.cbac_score, expected.cbac_score, patient);
  for (const k of Object.keys(expected.cbac_items)) {
    if (got.cbac_items[k] !== expected.cbac_items[k]) fail(i, `cbac_items.${k}`, got.cbac_items[k], expected.cbac_items[k], patient);
  }
  if (got.idrs_score !== expected.idrs_score) fail(i, 'idrs_score', got.idrs_score, expected.idrs_score, patient);
  for (const k of Object.keys(expected.idrs_items)) {
    if (got.idrs_items[k] !== expected.idrs_items[k]) fail(i, `idrs_items.${k}`, got.idrs_items[k], expected.idrs_items[k], patient);
  }
  if (got.idrs_band !== expected.idrs_band) fail(i, 'idrs_band', got.idrs_band, expected.idrs_band, patient);
  if (got.risk_band !== expected.risk_band) fail(i, 'risk_band', got.risk_band, expected.risk_band, patient);
  if (got.refer !== expected.refer) fail(i, 'refer', got.refer, expected.refer, patient);

  if (Math.abs(got._raw_dm - expected._raw_dm) > TOL) fail(i, 'raw diabetes prob', got._raw_dm, expected._raw_dm, patient);
  if (Math.abs(got._raw_htn - expected._raw_htn) > TOL) fail(i, 'raw hypertension prob', got._raw_htn, expected._raw_htn, patient);

  if (JSON.stringify(got.referral_reasons) !== JSON.stringify(expected.referral_reasons)) {
    fail(i, 'referral_reasons', got.referral_reasons, expected.referral_reasons, patient);
  }
  if (got.top_drivers.length !== expected.top_drivers.length) {
    fail(i, 'top_drivers length', got.top_drivers.length, expected.top_drivers.length, patient);
  } else {
    for (let d = 0; d < got.top_drivers.length; d++) {
      const a = got.top_drivers[d], b = expected.top_drivers[d];
      if (a.feature !== b.feature) fail(i, `driver[${d}].feature`, a.feature, b.feature, patient);
      if (a.label !== b.label) fail(i, `driver[${d}].label`, a.label, b.label, patient);
      if (Math.abs(a.contribution - b.contribution) > 1e-4 + TOL) {
        fail(i, `driver[${d}].contribution`, a.contribution, b.contribution, patient);
      }
    }
  }
}

console.log(`\nParity: ${n} cases  (boundary grid + generated cohort)`);
console.log(`Bands exercised: HIGH ${seen.HIGH}  MODERATE ${seen.MODERATE}  LOW ${seen.LOW}`);

// A test that only ever sees one band proves nothing about the banding logic.
const missing = Object.entries(seen).filter(([, v]) => v === 0).map(([k]) => k);
if (missing.length) {
  console.error(`\nWEAK TEST: no cases produced band(s) ${missing.join(', ')} — ` +
                `parity is unproven for those paths.`);
  process.exit(2);
}

if (failures) {
  console.error(`\n${failures} MISMATCH(ES) across ${shown.size} field(s): ${[...shown].join(', ')}`);
  console.error('The phone and the server would disagree on stage. Fix before demoing.');
  process.exit(1);
}
console.log('PARITY OK — risk.js and risk.py agree on every field of every case.\n');

/**
 * Nirogya on-device risk engine — a LINE-FOR-LINE port of server/risk.py.
 *
 * THIS IS THE FILE THAT MAKES "OFFLINE-FIRST AI" LITERALLY TRUE. It scores a
 * patient with no network, no server, no WASM — plain arithmetic over logistic
 * regression coefficients fetched once and cached. That is exactly why the model
 * is LR and not XGBoost.
 *
 * If you change scoring in server/risk.py, change it here and re-run:
 *     node tests/parity_test.js
 * The parity test compares both engines across hundreds of patients and fails on
 * any divergence, including the explanation strings.
 *
 * Works in the browser (ES module) and in Node (for the parity test).
 */

// ---------------------------------------------------------------------------
// CBAC — Community Based Assessment Checklist (MoHFW, NP-NCD programme)
// ---------------------------------------------------------------------------
// !! VERIFY these per-item weights against the official MoHFW CBAC operational
// guideline PDF before pitching. The >=4 referral cut-off is stable and widely
// cited; individual item point values vary between state versions.

export function cbacScore(p) {
  const b = {};
  const age = p.age;
  b.age = age < 40 ? 0 : age < 50 ? 1 : age < 60 ? 2 : 3;
  b.family_history = p.family_history ? 2 : 0;
  b.tobacco = { never: 0, former: 1, current: 2 }[p.tobacco];
  b.alcohol = p.alcohol ? 1 : 0;
  const w = p.waist_cm;
  if (p.sex === 'F') b.waist = w < 80 ? 0 : w <= 90 ? 1 : 2;
  else               b.waist = w < 90 ? 0 : w <= 100 ? 1 : 2;
  b.physical_inactivity = p.active_minutes_week >= 150 ? 0 : 1;
  const score = Object.values(b).reduce((a, c) => a + c, 0);
  return { score, items: b };
}

export const CBAC_PART_B = [
  'persistent_cough_2wk',
  'shortness_of_breath',
  'unexplained_weight_loss',
  'lump_or_sore_not_healing',
  'difficulty_opening_mouth',
];

export const PART_B_LABELS = {
  persistent_cough_2wk: 'Cough > 2 weeks (TB screen)',
  shortness_of_breath: 'Shortness of breath (COPD screen)',
  unexplained_weight_loss: 'Unexplained weight loss',
  lump_or_sore_not_healing: 'Lump / non-healing sore (cancer screen)',
  difficulty_opening_mouth: 'Difficulty opening mouth (oral cancer screen)',
};

export function cbacPartBFlag(p) {
  const hits = CBAC_PART_B.filter((k) => p[k]);
  return { flag: hits.length > 0, hits };
}

// ---------------------------------------------------------------------------
// IDRS — Indian Diabetes Risk Score (Madras Diabetes Research Foundation)
// ---------------------------------------------------------------------------
// Validated in Indian cohorts. This is what answers "why should this work on
// Indians?" — verify bands against MDRF / Mohan et al. before pitching.

export function idrsScore(p) {
  const b = {};
  const age = p.age;
  b.age = age < 35 ? 0 : age < 50 ? 20 : 30;
  const w = p.waist_cm;
  if (p.sex === 'F') b.waist = w < 80 ? 0 : w < 90 ? 10 : 20;
  else               b.waist = w < 90 ? 0 : w < 100 ? 10 : 20;
  b.physical_activity = { vigorous: 0, moderate: 10, mild: 20, sedentary: 30 }[p.activity_level];
  b.family_history = { 0: 0, 1: 10, 2: 20 }[Number(p.parents_with_diabetes || 0)];
  const score = Object.values(b).reduce((a, c) => a + c, 0);
  return { score, items: b };
}

export function idrsBand(s) {
  return s >= 60 ? 'high' : s >= 30 ? 'moderate' : 'low';
}

// ---------------------------------------------------------------------------
// ML layer — logistic regression on the CBAC feature space ONLY
// ---------------------------------------------------------------------------

export const FEATURES = ['age', 'waist_excess', 'is_male', 'family_hist_n',
                         'tobacco_current', 'alcohol', 'inactive'];

// Sex-specific abdominal-obesity cut-offs, as used by both CBAC and IDRS.
export const WAIST_CUTOFF = { M: 90.0, F: 80.0 };

let _weights = null;
export function setWeights(w) { _weights = w; }
export function getWeights() {
  if (!_weights) throw new Error('model weights not loaded — call setWeights() first');
  return _weights;
}
export function hasWeights() { return !!_weights; }

/**
 * cm above the sex-specific abdominal-obesity cut-off (may be negative).
 *
 * Do NOT substitute absolute waist here. Men's baseline waist is higher, so with
 * is_male also in the model the waist coefficient flips negative to compensate —
 * and the explainability panel then tells a judge, live, that a larger waist
 * reduces diabetes risk. bootstrap.py aborts if this regresses.
 */
export function waistExcess(p) {
  return Number(p.waist_cm) - WAIST_CUTOFF[p.sex];
}

export function featurise(p) {
  return [
    Number(p.age),
    waistExcess(p),
    p.sex === 'M' ? 1.0 : 0.0,
    Number(p.parents_with_diabetes || 0),
    p.tobacco === 'current' ? 1.0 : 0.0,
    p.alcohol ? 1.0 : 0.0,
    p.active_minutes_week < 150 ? 1.0 : 0.0,
  ];
}

export function predict(model, p) {
  const x = featurise(p);
  const z = x.map((v, i) => (v - model.mu[i]) / model.sd[i]);
  const logit = model.w.reduce((a, wj, j) => a + wj * z[j], 0) + model.b;
  const prob = 1.0 / (1.0 + Math.exp(-logit));
  // Same ordering rule as Python: descending |contribution|, stable on ties.
  const contrib = model.features
    .map((f, j) => [f, model.w[j] * z[j]])
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  return { prob, contrib };
}

// Python's round() is banker's rounding (round-half-to-even); JS Math.round is
// round-half-up. They differ on exact .5, which would silently break parity on
// the percentage in a referral reason string. Match Python.
function pyRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (Math.abs(d - 0.5) > Number.EPSILON * Math.abs(x) * 8) return Math.round(x);
  return f % 2 === 0 ? f : f + 1;
}

function fixed1(x) { return Number(x).toFixed(1); }

/**
 * Always render the PATIENT'S ACTUAL VALUE, never the bare feature name.
 *
 * Naming the feature alone produces sentences like "Physical inactivity reduces
 * risk" for a patient who is in fact active — mathematically correct (the value
 * is below the cohort mean) but it reads as a broken model, and that is exactly
 * what a judge pounces on.
 */
export function describeDriver(feature, contribution, p) {
  const we = waistExcess(p);
  const nParents = Number(p.parents_with_diabetes || 0);
  const v = {
    age: `Age ${Math.trunc(p.age)}`,
    waist_excess:
      `Waist ${fixed1(p.waist_cm)} cm — ${fixed1(Math.abs(we))} cm ` +
      `${we >= 0 ? 'above' : 'below'} the ` +
      `${Math.trunc(WAIST_CUTOFF[p.sex])} cm cut-off`,
    is_male: p.sex === 'M' ? 'Male' : 'Female',
    family_hist_n: nParents
      ? `Family history: ${nParents} parent(s) with diabetes`
      : 'No family history of diabetes',
    tobacco_current: p.tobacco === 'current' ? 'Current tobacco use' : `Tobacco: ${p.tobacco}`,
    alcohol: p.alcohol ? 'Alcohol use' : 'No alcohol use',
    inactive: p.active_minutes_week < 150
      ? `Physically inactive (${Math.trunc(p.active_minutes_week)} min/week)`
      : `Physically active (${Math.trunc(p.active_minutes_week)} min/week)`,
  }[feature];
  return `${v} — ${contribution > 0 ? 'increases' : 'reduces'} risk`;
}

/**
 * Deterministic government rules form a FLOOR the model cannot override.
 *
 * This is the answer to "what if your AI is wrong about someone?" — the model can
 * only ever ADD a referral, never remove one CBAC/IDRS require. Worst case it
 * over-refers. It can never under-refer relative to current practice.
 *
 * BANDING is a PRIORITY ORDERING INSIDE the referral floor, never a second gate:
 *   HIGH     - a CBAC Part B red flag (possible TB/COPD/cancer: urgent whatever
 *              the scores say), OR referred AND in the top slice of model risk.
 *   MODERATE - referred by the deterministic rules, but not top-slice.
 *   LOW      - no referral criterion met.
 * Nobody the government rules refer is ever dropped to LOW.
 */
export function assess(p) {
  const W = getWeights();
  const { score: cbac, items: cbacItems } = cbacScore(p);
  const { flag: partb, hits: partbHits } = cbacPartBFlag(p);
  const { score: idrs, items: idrsItems } = idrsScore(p);
  const dm = predict(W.diabetes, p);
  const htn = predict(W.hypertension, p);

  const highThr = (W.bands || {}).high_dm_prob ?? 0.5;
  const reasons = [];
  if (cbac >= 4) reasons.push(`CBAC score ${cbac} ≥ 4 (MoHFW referral criterion)`);
  if (partb) reasons.push('CBAC Part B: ' + partbHits.map((h) => PART_B_LABELS[h]).join(', '));
  if (idrs >= 60) reasons.push(`IDRS ${idrs} ≥ 60 (high risk, MDRF)`);
  if (dm.prob >= highThr) reasons.push(`ML diabetes risk ${pyRound(dm.prob * 100)}% (top-risk slice)`);

  let band;
  if (partb) band = 'HIGH';
  else if (reasons.length && dm.prob >= highThr) band = 'HIGH';
  else if (reasons.length) band = 'MODERATE';
  else band = 'LOW';

  return {
    cbac_score: cbac,
    cbac_items: cbacItems,
    cbac_part_b: partbHits,
    idrs_score: idrs,
    idrs_band: idrsBand(idrs),
    idrs_items: idrsItems,
    ml_diabetes_risk: Math.round(dm.prob * 1e4) / 1e4,
    ml_hypertension_risk: Math.round(htn.prob * 1e4) / 1e4,
    high_risk_threshold: highThr,
    risk_band: band,
    refer: reasons.length > 0,
    referral_reasons: reasons,
    top_drivers: dm.contrib.slice(0, 3).map(([f, c]) => ({
      feature: f,
      contribution: Math.round(c * 1e4) / 1e4,
      label: describeDriver(f, c, p),
    })),
    // raw, unrounded — the parity test needs full precision
    _raw_dm: dm.prob,
    _raw_htn: htn.prob,
  };
}

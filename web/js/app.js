/**
 * Nirogya app shell: hash router + screens.
 *
 * No framework and no build step. That is a deliberate constraint, not a
 * shortcut: it means the app opens from a static directory, works on any Android
 * Chrome, and cannot break because of a toolchain problem the night before the
 * demo. Every screen is a function returning a DOM node, so porting a screen to
 * a React component later is mechanical.
 *
 * THE IMPORTANT PROPERTY: scoring calls risk.assess() locally. Submitting a
 * screening never waits on the network. Turn the Wi-Fi off and everything except
 * the district dashboard still works.
 */

import * as api from './api.js';
import * as risk from './risk.js';
import { pickProvider, listenWithFallback, parseSpokenNumber, parseSpokenYesNo } from './voice.js';
import { caps, capsSummary, secureContextFix } from './capability.js';

const view = document.getElementById('view');
const voice = pickProvider();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * SVG element factory. Separate from h() on purpose, for two reasons.
 *
 * 1. SVG needs createElementNS. document.createElement('svg') returns an
 *    HTMLUnknownElement in the XHTML namespace: it lays out as a blank box of
 *    the CSS height and paints nothing. The trend charts were three empty
 *    318x62 gaps for exactly that reason. Setting .innerHTML on that element
 *    does not help either — the fragment parses in the HTML namespace, so
 *    <path> becomes an unknown HTML element with no geometry, and <circle/>
 *    does not self-close, so every dot ended up nested inside the path.
 * 2. SVGElement.className is a read-only SVGAnimatedString, so h()'s
 *    `el.className = v` shortcut throws here. Everything goes via setAttribute.
 *
 * Building the nodes rather than assembling a markup string is also what let the
 * `html:`/innerHTML branch come out of h(): there is now no innerHTML sink
 * anywhere in the app, so no data path can reach the HTML parser at all.
 */
function svgEl(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid);
  }
  return el;
}

let toastTimer;
function toast(msg, kind = '') {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = h('div', { class: `toast ${kind}` }, msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 3600);
}

const pct = (x) => `${Math.round(x * 100)}%`;
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : `u-${Date.now()}-${Math.random().toString(16).slice(2)}`);

async function paintStatus() {
  const online = api.isOnline();
  const pill = document.getElementById('net-pill');
  pill.classList.toggle('off', !online);
  document.getElementById('net-text').textContent = online ? 'Online' : 'Offline';
  const n = await api.pendingCount();
  const qp = document.getElementById('queue-pill');
  qp.hidden = n === 0;
  qp.textContent = `${n} pending sync`;
  // A rejected record is invisible unless we say so. It is out of the queue, so
  // the pending count is zero and every other signal in the app reads "all
  // synced" while a real screening sits there unsent.
  const rp = document.getElementById('reject-pill');
  if (rp) {
    const bad = await api.rejectedRecords();
    rp.hidden = bad.length === 0;
    rp.textContent = `${bad.length} rejected`;
  }
  paintCapabilityBanner();
}
api.onStatusChange(paintStatus);

/**
 * A persistent banner whenever offline reload is unavailable.
 *
 * This is the fix for the worst class of bug this app can have: claiming an
 * offline-first design while the service worker was never registered, and
 * showing nothing at all to say so. The banner is deliberately hard to miss and
 * deliberately not dismissible while the condition holds.
 */
function paintCapabilityBanner() {
  const host = document.getElementById('capbanner');
  if (!host) return;
  const reason = caps.offlineReason();
  if (!reason) { host.hidden = true; host.textContent = ''; return; }
  host.hidden = false;
  host.textContent = '';
  host.append(
    h('b', {}, '⚠ '),
    h('span', {}, reason),
    h('span', { class: 'cap-ok' },
      ' Screening and on-device scoring still work; queued records still sync.'),
    h('a', { href: '#/preflight' }, 'How to fix'),
  );
}

function staleNote(res) {
  if (!res || !res.stale) return null;
  const when = res.cachedAt ? new Date(res.cachedAt).toLocaleTimeString() : 'earlier';
  return h('div', { class: 'notice' },
    `Offline — showing data cached at ${when}. Screening still works normally.`);
}

// ---------------------------------------------------------------------------
// screen 1: CBAC screening form
// ---------------------------------------------------------------------------

const VILLAGES = ['Byndoor', 'Kundapura', 'Shankaranarayana', 'Hebri',
                  'Brahmavar', 'Ajekar', 'Karkala', 'Kaup'];

const state = {
  form: null,
  lastResult: null,
};

function blankForm() {
  return {
    name: '', sex: 'F', age: '', village: 'Byndoor',
    waist_cm: '', activity_level: 'moderate',
    parents_with_diabetes: 0, tobacco: 'never', alcohol: false,
    sbp: '', dbp: '', fbs: '',
    persistent_cough_2wk: false, shortness_of_breath: false,
    unexplained_weight_loss: false, lump_or_sore_not_healing: false,
    difficulty_opening_mouth: false,
  };
}

const ACTIVITY_MINUTES = { vigorous: 300, moderate: 180, mild: 90, sedentary: 20 };

/**
 * Plausible range per voice-enabled field, matching the typed input's own
 * min/max. A transcription slip that turns a waist of 82 cm into 8200 has to be
 * refused, not stored — and the voice path must refuse exactly what the keyboard
 * path refuses, or the two disagree about what a valid reading is.
 */
const VOICE_RANGE = {
  age: { min: 1, max: 120, label: 'Age' },
  waist: { min: 40, max: 160, label: 'Waist' },
  fbs: { min: 20, max: 600, label: 'Fasting blood sugar' },
};

/** The live-transcript line under a mic'd field, created on first use. */
function liveLine(btn) {
  const host = btn.closest('.with-mic') || btn.parentElement;
  let el = host.nextElementSibling;
  if (!el || !el.classList.contains('vlive')) {
    el = h('div', { class: 'vlive', 'aria-live': 'polite' });
    host.after(el);
  }
  return el;
}

/**
 * Mic button bound to one field. Two rules, both learned the hard way:
 *
 *  - SHOW THE TRANSCRIPT. Partial text streams into a live line under the field
 *    while the ASHA is still speaking, and the final transcript stays on screen
 *    afterwards. Without it the button looks dead for the second or two before
 *    recognition finalises, and a parse failure left nothing at all behind —
 *    which is what "the voice does not write anything" actually meant.
 *
 *  - NEVER AUTO-COMMIT. The parsed number lands in the editable input so it can
 *    be corrected, and a value outside the field's plausible range is refused
 *    rather than written.
 */
function micButton(onValue, { kind = 'number', range = null } = {}) {
  const btn = h('button', {
    class: 'mic', type: 'button', title: 'Speak in Kannada',
    'aria-label': 'Speak this field in Kannada',
  }, '🎤');
  let listening = false;

  const say = (el, cls, text) => { el.className = `vlive ${cls}`; el.textContent = text; };

  btn.addEventListener('click', async () => {
    const live = liveLine(btn);
    if (listening) { voice.stop(); return; }   // second tap stops listening

    // Say WHY, not just "not supported". On a phone the cause is almost always
    // the insecure origin, which is fixable in 2 minutes -- but only if the
    // message points at it instead of implying the browser is too old.
    if (!voice.available) {
      const why = caps.voiceReason() || 'Voice unavailable on this device.';
      say(live, 'err', why); toast(why, 'err'); return;
    }
    if (!api.isOnline()) {
      const why = 'Voice needs a network — Chrome sends the audio to Google to recognise it. Type the value.';
      say(live, 'err', why); toast('Voice needs a network', 'err'); return;
    }

    listening = true;
    btn.classList.add('listening');
    btn.setAttribute('aria-label', 'Stop listening');
    say(live, 'on', 'Listening…');
    try {
      const r = await listenWithFallback(voice, {
        onInterim: (t) => say(live, 'on', t),
        onLang: (l) => { live.dataset.lang = l; },
      });
      const heard = `“${r.transcript}”${r.interim ? ' (partial)' : ''}`;
      const parsed = kind === 'yesno'
        ? parseSpokenYesNo(r.transcript)
        : parseSpokenNumber(r.transcript, range || {});

      if (parsed == null) {
        // Keep the transcript on screen. The ASHA can see what was heard and
        // fix it, which is far more useful than a toast that vanishes.
        const bound = range ? ` Expected ${range.min}–${range.max}.` : '';
        say(live, 'err', `Heard ${heard} — could not read a value from that.${bound} Please type it.`);
        toast('Could not read a number — type it', 'err');
      } else {
        onValue(parsed);
        say(live, 'ok', `Heard ${heard} → ${parsed}`);
        toast(`Heard ${heard} → ${parsed}`, 'ok');
      }
    } catch (e) {
      const help = e && e.message ? e.message : String(e);
      say(live, 'err', help);
      toast(e && e.code === 'no-speech' ? 'Did not catch that' : help, 'err');
    } finally {
      listening = false;
      btn.classList.remove('listening');
      btn.setAttribute('aria-label', 'Speak this field in Kannada');
    }
  });
  return btn;
}

function field(label, hint, ...controls) {
  return h('div', { class: 'field' },
    h('label', {}, label, hint ? h('span', { class: 'hint' }, ` — ${hint}`) : null),
    ...controls);
}

function chipGroup(options, current, onPick) {
  const wrap = h('div', { class: 'chips' });
  options.forEach(([val, lab]) => {
    const c = h('button', { class: 'chip', type: 'button', 'aria-pressed': String(val === current) }, lab);
    c.addEventListener('click', () => {
      onPick(val);
      wrap.querySelectorAll('.chip').forEach((x) => x.setAttribute('aria-pressed', 'false'));
      c.setAttribute('aria-pressed', 'true');
    });
    wrap.append(c);
  });
  return wrap;
}

function screenForm() {
  if (!state.form) state.form = blankForm();
  const f = state.form;
  const wrap = h('div', { class: 'stack' });

  const nameIn = h('input', { type: 'text', value: f.name, placeholder: 'Patient name', oninput: (e) => { f.name = e.target.value; } });
  const ageIn = h('input', { type: 'number', inputmode: 'numeric', min: '1', max: '120', value: f.age, placeholder: 'Years', oninput: (e) => { f.age = e.target.value; } });
  const waistIn = h('input', { type: 'number', inputmode: 'decimal', step: '0.5', min: '40', max: '160', value: f.waist_cm, placeholder: 'cm', oninput: (e) => { f.waist_cm = e.target.value; } });
  // min/max mirror VOICE_RANGE so a typed value and a spoken value are held to
  // the same bounds. Divergence there is how a reading the keyboard rejects gets
  // in through the microphone.
  const sbpIn = h('input', { type: 'number', inputmode: 'numeric', min: '60', max: '260', value: f.sbp, placeholder: 'Systolic', oninput: (e) => { f.sbp = e.target.value; } });
  const dbpIn = h('input', { type: 'number', inputmode: 'numeric', min: '30', max: '180', value: f.dbp, placeholder: 'Diastolic', oninput: (e) => { f.dbp = e.target.value; } });
  const fbsIn = h('input', { type: 'number', inputmode: 'numeric', min: '20', max: '600', value: f.fbs, placeholder: 'mg/dL (optional)', oninput: (e) => { f.fbs = e.target.value; } });

  const villageSel = h('select', { onchange: (e) => { f.village = e.target.value; } },
    ...VILLAGES.map((v) => h('option', { value: v, selected: v === f.village }, v)));

  const partB = h('div', {},
    ...risk.CBAC_PART_B.map((k) => {
      const id = `pb-${k}`;
      return h('div', { class: 'check' },
        h('input', { type: 'checkbox', id, checked: f[k], onchange: (e) => { f[k] = e.target.checked; } }),
        h('label', { for: id }, risk.PART_B_LABELS[k]));
    }));

  wrap.append(
    h('div', { class: 'card' },
      h('div', { class: 'card-h' }, h('h1', {}, 'New screening'),
        h('div', { class: 'spacer' }),
        h('small', {}, 'CBAC Part A + B')),
      field('Name', null, nameIn),
      h('div', { class: 'row' },
        field('Age', 'CBAC + IDRS', h('div', { class: 'with-mic' }, ageIn,
          micButton((v) => { f.age = v; ageIn.value = v; }, { range: VOICE_RANGE.age }))),
        field('Sex', null, chipGroup([['F', 'Female'], ['M', 'Male']], f.sex, (v) => { f.sex = v; }))),
      field('Village', null, villageSel),
      field('Waist circumference', 'cut-off 90 cm male / 80 cm female',
        h('div', { class: 'with-mic' }, waistIn,
          micButton((v) => { f.waist_cm = v; waistIn.value = v; }, { range: VOICE_RANGE.waist }))),
      field('Physical activity', 'IDRS + CBAC inactivity point',
        chipGroup([['vigorous', 'Vigorous'], ['moderate', 'Moderate'], ['mild', 'Mild'], ['sedentary', 'Sedentary']],
          f.activity_level, (v) => { f.activity_level = v; })),
      field('Parents with diabetes', 'IDRS family history',
        chipGroup([[0, 'None'], [1, 'One'], [2, 'Both']], f.parents_with_diabetes,
          (v) => { f.parents_with_diabetes = v; })),
      field('Tobacco use', 'any form, incl. smokeless',
        chipGroup([['never', 'Never'], ['former', 'Former'], ['current', 'Current']], f.tobacco,
          (v) => { f.tobacco = v; })),
      field('Alcohol use', null,
        chipGroup([[false, 'No'], [true, 'Yes']], f.alcohol, (v) => { f.alcohol = v; })),
    ),
    h('div', { class: 'card' },
      h('h2', {}, 'Measurements'),
      h('small', {}, 'Optional. BP is measured, never predicted — see the Model tab.'),
      h('div', { class: 'row', style: 'margin-top:10px' },
        field('Blood pressure', 'mmHg', h('div', { class: 'row' }, sbpIn, dbpIn))),
      field('Fasting blood sugar', 'mg/dL', h('div', { class: 'with-mic' }, fbsIn,
        micButton((v) => { f.fbs = v; fbsIn.value = v; }, { range: VOICE_RANGE.fbs }))),
    ),
    h('div', { class: 'card' },
      h('h2', {}, 'CBAC Part B — symptom red flags'),
      h('small', {}, 'Any one of these refers the patient regardless of score.'),
      partB),
    h('button', { class: 'block', onclick: () => submit() }, 'Score & save'),
    // The last result is rendered FROM state, not appended imperatively, so a
    // re-render of this form (which is how the fields get cleared — see submit)
    // keeps the card that explains the screening just saved. route() clears
    // state.lastResult when the ASHA navigates away.
    h('div', { id: 'result-slot' },
      ...(state.lastResult
        ? [resultCard(state.lastResult.assessment, state.lastResult.patient, state.lastResult.res)]
        : [])),
  );
  return wrap;
}

function toPatient(f) {
  return {
    name: f.name.trim() || 'Unnamed',
    sex: f.sex,
    age: Number(f.age),
    village: f.village,
    waist_cm: Number(f.waist_cm),
    activity_level: f.activity_level,
    active_minutes_week: ACTIVITY_MINUTES[f.activity_level],
    parents_with_diabetes: Number(f.parents_with_diabetes),
    family_history: Number(f.parents_with_diabetes) > 0,
    tobacco: f.tobacco,
    alcohol: !!f.alcohol,
    sbp: f.sbp === '' ? null : Number(f.sbp),
    dbp: f.dbp === '' ? null : Number(f.dbp),
    fbs: f.fbs === '' ? null : Number(f.fbs),
    ...Object.fromEntries(risk.CBAC_PART_B.map((k) => [k, !!f[k]])),
  };
}

/**
 * Score, persist, and reset.
 *
 * The reset is a re-render, and it has to be. `state.form = blankForm()` on its
 * own left every <input> in the DOM still showing the previous patient's values,
 * because those inputs were created once with `value: f.age` and only ever write
 * BACK to state on input. State was blank, the screen was not. The ASHA saw a
 * filled form, changed the two fields that differ for the next patient, and
 * submitted a record carrying a blank name, the default sex, the default village
 * and the default tobacco answer — silently, with a plausible-looking risk score
 * on the end of it. Worse than a crash, because nothing looks wrong.
 */
async function submit(wrap) {
  const f = state.form;
  if (!f.age || Number(f.age) < 1) { toast('Age is required', 'err'); return; }
  if (!f.waist_cm) { toast('Waist circumference is required', 'err'); return; }

  const p = toPatient(f);

  // Scored HERE, on the device, with no network. This is the demo's core claim.
  const a = risk.assess(p);

  const payload = { ...p, client_uuid: uuid(), screened_on: new Date().toISOString().slice(0, 10) };
  const res = await api.submitScreening(payload);
  await paintStatus();

  state.lastResult = { assessment: a, patient: p, res };
  state.form = blankForm();

  // Rebuild the form from the now-blank state, then put the result card back into
  // the fresh #result-slot. Order matters: replaceChildren discards the old
  // subtree, so the slot has to be re-queried on the new one.
  view.replaceChildren(screenForm());
  const slot = view.querySelector('#result-slot');
  if (slot) slot.scrollIntoView({ behavior: 'smooth', block: 'start' });

  if (res.rejected) {
    // The device scored this record and the server refused it. That is a genuine
    // client/server disagreement, so it gets the loud treatment rather than the
    // usual "queued" reassurance.
    toast('Server rejected this record — see the note above', 'err');
  } else {
    toast(res.synced ? 'Saved and synced' : 'Saved on device — queued for sync',
          res.synced ? 'ok' : '');
  }
}

/**
 * One "why this score" row: a signed contribution bar plus its plain-language
 * label. Shared by the post-screening result card and the patient detail page,
 * which previously rendered the same top_drivers data two different ways — the
 * detail page showed the label with no bar, so the explainability panel looked
 * weaker there for no reason. The bar grows from the centre: right and red for a
 * factor that raises risk, left and green for one that lowers it.
 */
function driverRow(d) {
  const mag = Math.min(1, Math.abs(d.contribution) / 1.5);
  const bar = h('span', { class: 'bar' },
    h('i', {
      class: d.contribution > 0 ? '' : 'neg',
      style: d.contribution > 0
        ? `left:50%;width:${mag * 50}%`
        : `left:${50 - mag * 50}%;width:${mag * 50}%`,
    }));
  return h('div', { class: 'driver' }, bar, h('span', {}, d.label));
}

function resultCard(a, p, res) {
  const drivers = h('div', {}, ...a.top_drivers.map(driverRow));

  return h('div', { class: `card result ${a.risk_band}` },
    h('div', { class: 'card-h' },
      h('h2', {}, p.name),
      h('div', { class: 'spacer' }),
      h('span', { class: `band ${a.risk_band}` }, a.risk_band)),

    h('div', { class: 'scores' },
      h('div', { class: 'score' }, h('div', { class: 'v' }, a.cbac_score), h('div', { class: 'k' }, 'CBAC')),
      h('div', { class: 'score' }, h('div', { class: 'v' }, a.idrs_score), h('div', { class: 'k' }, `IDRS ${a.idrs_band}`)),
      h('div', { class: 'score' }, h('div', { class: 'v' }, pct(a.ml_diabetes_risk)), h('div', { class: 'k' }, 'ML diabetes'))),

    a.refer
      ? h('div', {}, h('h3', {}, 'Refer to PHC — why'),
          h('ul', { class: 'reasons' }, ...a.referral_reasons.map((r) => h('li', {}, r))))
      : h('p', { class: 'muted' }, 'No referral criterion met. Re-screen at the next visit.'),

    h('h3', { style: 'margin-top:12px' }, 'Top drivers for this person'),
    drivers,

    // Three states, not two. "Queued" and "synced" are both fine; "the server
    // refused it" is not, and it used to render as "queued, will sync
    // automatically" — a reassurance about something that will never happen.
    res.rejected
      ? h('div', { class: 'alert', style: 'margin-top:11px' },
          h('b', {}, 'Not accepted by the server. '),
          res.rejected.message || 'This record cannot be saved as it stands.',
          ...((res.rejected.fields || []).length
            ? [h('ul', { class: 'reasons', style: 'margin-top:6px' },
                ...res.rejected.fields.map((fl) =>
                  h('li', {}, h('b', {}, `${fl.field}: `), fl.message)))]
            : []),
          h('div', { class: 'alert-sub' },
            'The screening is saved on this device and is listed under Preflight, '
            + 'so nothing is lost. Re-enter it with the field above corrected.'))
      : h('small', { style: 'display:block;margin-top:10px' },
          res.synced
            ? 'Scored on device · synced to server'
            : 'Scored on device with no network · queued, will sync automatically'),
  );
}

// ---------------------------------------------------------------------------
// screen 2: roster / work queue
// ---------------------------------------------------------------------------

const rosterFilters = { village: '', band: '', q: '' };

async function rosterScreen() {
  const wrap = h('div', { class: 'stack' });
  const list = h('div', { class: 'plist' }, h('div', { class: 'card center muted' }, 'Loading…'));

  const controls = h('div', { class: 'filters' },
    h('select', { onchange: (e) => { rosterFilters.village = e.target.value; load(); } },
      h('option', { value: '' }, 'All villages'),
      ...VILLAGES.map((v) => h('option', { value: v, selected: v === rosterFilters.village }, v))),
    h('select', { onchange: (e) => { rosterFilters.band = e.target.value; load(); } },
      h('option', { value: '' }, 'All bands'),
      ...['HIGH', 'MODERATE', 'LOW'].map((b) => h('option', { value: b, selected: b === rosterFilters.band }, b))),
    h('input', { type: 'text', placeholder: 'Search name / ID', value: rosterFilters.q,
      oninput: (e) => { rosterFilters.q = e.target.value; clearTimeout(controls._t); controls._t = setTimeout(load, 260); } }));

  async function load() {
    try {
      const res = await api.getPatients({ ...rosterFilters, limit: 60 });
      const rows = res.data.patients || [];
      list.replaceChildren(
        staleNote(res) || '',
        ...(rows.length ? rows.map(patientRow)
                        : [h('div', { class: 'card center muted' }, 'No patients match.')]));
    } catch {
      list.replaceChildren(h('div', { class: 'card center muted' },
        'Cannot reach the server and nothing is cached yet. Screening still works.'));
    }
  }

  wrap.append(
    h('div', { class: 'card tight' },
      h('div', { class: 'card-h' },
        h('h1', {}, 'Follow-up queue'),
        h('div', { class: 'spacer' }),
        h('button', { class: 'ghost sm', onclick: doSync }, 'Sync now')),
      h('small', {}, 'Highest risk first. This ordering is the point — CBAC alone refers ~46% of adults.'),
      controls),
    list);
  load();
  return wrap;
}

function patientRow(p) {
  return h('button', { class: 'prow', onclick: () => { location.hash = `#/patient/${p.patient_id}`; } },
    h('span', { class: `band ${p.risk_band}` }, p.risk_band[0]),
    h('span', { class: 'who' },
      h('span', { class: 'nm' }, p.name),
      h('span', { class: 'mt' }, `${p.age}${p.sex} · ${p.village} · CBAC ${p.cbac_score} · IDRS ${p.idrs_score}`)),
    h('span', { class: 'rt' },
      h('span', { class: 'pc' }, pct(p.ml_diabetes_risk)),
      h('span', { class: 'mt', style: 'display:block' }, p.screened_on)));
}

/**
 * Manual sync, and the honest report of what happened.
 *
 * "Synced 4" when the server actually refused one of them is the kind of message
 * that turns a fixable data-entry mistake into a permanently missing patient. All
 * three counts are reported, and a rejection wins the colour.
 */
async function doSync() {
  if (!api.isOnline()) { toast('Still offline — queue is safe', 'err'); return; }
  try {
    const r = await api.syncNow();
    await paintStatus();
    if (r.rejected) {
      toast(`Synced ${r.applied}, but ${r.rejected} record(s) were rejected — see the red badge`, 'err');
    } else if (r.applied || r.duplicates) {
      toast(`Synced ${r.applied} new, ${r.duplicates} duplicate(s) ignored`, 'ok');
    } else if (r.errors.length) {
      // Transient failures only: nothing applied, nothing rejected, still queued.
      toast(`${r.errors.length} record(s) could not be sent — still queued, will retry`, 'err');
    } else {
      toast('Nothing to sync', 'ok');
    }
  } catch (e) {
    toast(`Sync failed: ${e.message}`, 'err');
  }
}

// ---------------------------------------------------------------------------
// screen 3: patient detail + trend
// ---------------------------------------------------------------------------

function sparkline(values, { label, unit }) {
  if (values.length < 2) return null;
  const W = 320, H = 62, pad = 6;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = pad + (i * (W - 2 * pad)) / (values.length - 1);
    const y = H - pad - ((v - min) / span) * (H - 2 * pad);
    return [x, y];
  });
  const path = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const rising = values[values.length - 1] > values[0];
  const col = rising ? '#c62828' : '#2e7d32';
  return h('div', {},
    h('div', { style: 'display:flex;justify-content:space-between;font-size:12.5px' },
      h('b', {}, label),
      h('span', { class: 'muted' }, `${values[0]} → ${values[values.length - 1]} ${unit}`)),
    // role=img + aria-label because a chart with no text alternative is simply
    // absent to a screen reader, and the numbers are the whole point here.
    svgEl('svg', {
      class: 'spark', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none',
      role: 'img',
      'aria-label': `${label} across ${values.length} visits: ${values.join(', ')} ${unit}`,
    },
      svgEl('path', {
        d: path, fill: 'none', stroke: col, 'stroke-width': 2.5,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      }),
      ...pts.map(([x, y]) => svgEl('circle', {
        cx: x.toFixed(1), cy: y.toFixed(1), r: 2.6, fill: col,
      }))));
}

async function patientScreen(id) {
  const wrap = h('div', { class: 'stack' }, h('div', { class: 'card center muted' }, 'Loading…'));
  try {
    const res = await api.getPatient(id);
    const { patient, history, alerts } = res.data;
    if (!patient) { wrap.replaceChildren(h('div', { class: 'card' }, 'Patient not found.')); return wrap; }
    const latest = history[history.length - 1] || {};
    // The server already parses these JSON columns for us.
    const drivers = latest.top_drivers || [];
    const band = latest.risk_band || 'LOW';

    const kids = [
      staleNote(res),
      h('div', { class: 'card' },
        h('div', { class: 'card-h' },
          h('h1', {}, patient.name),
          h('div', { class: 'spacer' }),
          h('span', { class: `band ${band}` }, latest.risk_band || '—')),
        h('small', {}, `${patient.patient_id} · ${patient.age}${patient.sex} · ${patient.village} · ${history.length} visit(s)`),
        h('div', { class: 'scores' },
          h('div', { class: 'score' }, h('div', { class: 'v' }, latest.cbac_score ?? '—'), h('div', { class: 'k' }, 'CBAC')),
          h('div', { class: 'score' }, h('div', { class: 'v' }, latest.idrs_score ?? '—'), h('div', { class: 'k' }, 'IDRS')),
          h('div', { class: 'score' }, h('div', { class: 'v' }, latest.ml_diabetes_risk != null ? pct(latest.ml_diabetes_risk) : '—'), h('div', { class: 'k' }, 'ML diabetes'))),
        (latest.referral_reasons || []).length
          ? h('div', {}, h('h3', {}, 'Referral reasons'),
              h('ul', { class: 'reasons' }, ...latest.referral_reasons.map((r) => h('li', {}, r))))
          : null),
    ];

    if (alerts && alerts.length) {
      kids.push(h('div', { class: 'card' },
        h('h2', {}, 'Deterioration alerts'),
        // The sub-line is not decoration. The delta is measured from the mean of
        // the first two visits, so it will not equal (last - first) in the table
        // above. Spell that out here or it reads as a arithmetic bug.
        ...alerts.map((a) => h('div', { class: 'alert' },
          h('div', {}, h('b', {}, '▲ '), a.message),
          a.baseline_note
            ? h('div', { class: 'alert-sub' },
                `First visit ${a.first_value} ${a.unit} · ${a.baseline_note} = `
                + `${a.from} ${a.unit} · latest ${a.to} ${a.unit}`)
            : null))));
    }

    if (history.length >= 2) {
      const series = [
        ['fbs', 'Fasting blood sugar', 'mg/dL'],
        ['sbp', 'Systolic BP', 'mmHg'],
        ['waist_cm', 'Waist', 'cm'],
      ].map(([k, label, unit]) => {
        const vals = history.map((x) => x[k]).filter((v) => v != null);
        return vals.length >= 2 ? sparkline(vals, { label, unit }) : null;
      }).filter(Boolean);
      if (series.length) {
        kids.push(h('div', { class: 'card' },
          h('h2', {}, `Trend over ${history.length} visits`),
          h('div', { class: 'stack' }, ...series)));
      }
    }

    if (drivers.length) {
      kids.push(h('div', { class: 'card' },
        h('h2', {}, 'Why this score'),
        ...drivers.map(driverRow)));
    }

    kids.push(h('div', { class: 'card tight' },
      h('h3', {}, 'Visit history'),
      h('div', { class: 'tscroll' }, h('table', { class: 'tbl' },
        h('thead', {},
          h('tr', {}, h('th', { scope: 'col' }, 'Date'), h('th', { class: 'num', scope: 'col' }, 'FBS'),
            h('th', { class: 'num', scope: 'col' }, 'BP'), h('th', { class: 'num', scope: 'col' }, 'Waist'),
            h('th', { scope: 'col' }, 'Band'))),
        h('tbody', {},
          ...history.slice().reverse().map((v) => h('tr', {},
            h('td', {}, v.screened_on),
            h('td', { class: 'num' }, v.fbs ?? '—'),
            h('td', { class: 'num' }, v.sbp ? `${v.sbp}/${v.dbp}` : '—'),
            h('td', { class: 'num' }, v.waist_cm ?? '—'),
            h('td', {}, h('span', { class: `band ${v.risk_band}` }, v.risk_band)))))))));

    wrap.replaceChildren(...kids.filter(Boolean));
  } catch (e) {
    // A 404 and a dead network are different problems with different fixes, and
    // telling the ASHA to check their signal when the id is simply wrong sends
    // them looking in the wrong place. getJSON attaches the status for exactly this.
    wrap.replaceChildren(e.status === 404
      ? h('div', { class: 'card' },
          h('h2', {}, 'Patient not found'),
          h('p', {}, h('span', { class: 'mono' }, id), ' does not exist on the server.'),
          h('p', {}, h('a', { href: '#/roster' }, 'Back to the queue')))
      : h('div', { class: 'card center muted' },
          'Patient history needs the server. Offline screening is unaffected.'));
  }
  return wrap;
}

// ---------------------------------------------------------------------------
// screen 4: district dashboard
// ---------------------------------------------------------------------------

async function dashboardScreen() {
  const wrap = h('div', { class: 'stack' }, h('div', { class: 'card center muted' }, 'Loading…'));
  try {
    const [vres, sres] = await Promise.all([api.getVillages(), api.getStats()]);
    const villages = vres.data.villages || [];
    const s = sres.data;
    const worst = villages[0];
    const maxPct = Math.max(...villages.map((v) => v.high_pct), 1);

    wrap.replaceChildren(
      staleNote(vres) || '',
      h('div', { class: 'callout' },
        h('div', { class: 't' }, 'Recommended next mobile health camp'),
        h('div', { class: 'm' }, worst ? `${worst.village} — ${worst.high_pct}% high risk` : '—'),
        h('small', {}, worst
          ? `${worst.high} of ${worst.screened} screened are high risk, against a district average of ${
              (villages.reduce((a, v) => a + v.high, 0) / Math.max(1, villages.reduce((a, v) => a + v.screened, 0)) * 100).toFixed(1)
            }%.`
          : '')),

      h('div', { class: 'kpis' },
        h('div', { class: 'kpi' }, h('div', { class: 'v' }, s.screenings), h('div', { class: 'k' }, 'Screenings')),
        h('div', { class: 'kpi' }, h('div', { class: 'v' }, s.high_risk), h('div', { class: 'k' }, 'High risk')),
        h('div', { class: 'kpi' }, h('div', { class: 'v' }, s.referred), h('div', { class: 'k' }, 'Referred to PHC')),
        h('div', { class: 'kpi' }, h('div', { class: 'v' }, s.villages), h('div', { class: 'k' }, 'Villages')),
      ),

      h('div', { class: 'card' },
        h('div', { class: 'card-h' }, h('h2', {}, 'Village risk heatmap'),
          h('div', { class: 'spacer' }), h('small', {}, '% high risk')),
        h('div', { class: 'heat' }, ...villages.map((v) => h('div', { class: 'heatrow' },
          h('span', { class: 'v' }, v.village),
          h('span', { class: 'track' }, h('i', { style: `width:${(v.high_pct / maxPct) * 100}%` })),
          h('span', { class: 'n' }, `${v.high_pct}%`)))),
        h('small', { style: 'display:block;margin-top:9px' },
          'Clustering is what turns individual screening into a population signal — this is the view a taluk health officer does not currently have.')),

      h('div', { class: 'card tight' },
        h('h3', {}, 'By village'),
        h('div', { class: 'tscroll' }, h('table', { class: 'tbl' },
          h('thead', {},
            h('tr', {},
              h('th', { scope: 'col' }, 'Village'),
              // Units belong in the header. These three columns carried bare
              // labels while holding percentages, so "High 36.8" read as 36.8
              // people rather than 36.8% of those screened.
              h('th', { class: 'num', scope: 'col' }, 'Screened'),
              h('th', { class: 'num', scope: 'col' }, 'High %'),
              h('th', { class: 'num', scope: 'col' }, 'Referred %'),
              h('th', { class: 'num', scope: 'col' }, 'Mean CBAC'))),
          h('tbody', {},
            ...villages.map((v) => h('tr', {},
              h('th', { class: 'vname', scope: 'row' }, v.village),
              h('td', { class: 'num' }, v.screened),
              h('td', { class: 'num' }, `${v.high_pct}%`),
              h('td', { class: 'num' }, `${v.refer_pct}%`),
              h('td', { class: 'num' }, v.mean_cbac))))))),
    );
  } catch {
    wrap.replaceChildren(h('div', { class: 'card center muted' },
      'The district dashboard is a server view — it needs a connection. The ASHA app does not.'));
  }
  return wrap;
}

// ---------------------------------------------------------------------------
// screen 5: model card — built for judges
// ---------------------------------------------------------------------------

async function modelScreen() {
  const W = risk.getWeights();
  const dm = W.eval.diabetes, htn = W.eval.hypertension;
  const op = dm.at_80pct_sensitivity;
  const coef = W.diabetes.features.map((f, i) => [f, W.diabetes.w[i]])
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));

  return h('div', { class: 'stack' },
    h('div', { class: 'card' },
      h('h1', {}, 'Model card'),
      h('small', {}, 'Everything a judge is likely to ask, on one screen.'),
      h('div', { class: 'scores', style: 'margin-top:12px' },
        h('div', { class: 'score' }, h('div', { class: 'v' }, dm.auc), h('div', { class: 'k' }, 'Diabetes AUC')),
        h('div', { class: 'score' }, h('div', { class: 'v' }, `${Math.round(op.sensitivity * 100)}%`), h('div', { class: 'k' }, 'Sensitivity')),
        h('div', { class: 'score' }, h('div', { class: 'v' }, `${Math.round(op.specificity * 100)}%`), h('div', { class: 'k' }, 'Specificity'))),
      h('p', { style: 'margin-top:10px' },
        `Tuned for sensitivity, not accuracy. At threshold ${op.threshold} the model catches ` +
        `${Math.round(op.sensitivity * 100)}% of diabetes cases. Missing a diabetic in a village we may not ` +
        `revisit for months costs far more than an unnecessary PHC referral.`)),

    h('div', { class: 'card' },
      h('h2', {}, 'Safety architecture'),
      h('p', {}, 'The deterministic government rules are a FLOOR the model cannot override. ' +
        'CBAC ≥ 4, any CBAC Part B red flag, or IDRS ≥ 60 refers the patient regardless of what the ' +
        'model says. The model can only ever ADD a referral, never remove one.'),
      h('p', { class: 'muted' },
        `The HIGH band is a priority ordering inside that floor: a Part B red flag, or referred with ` +
        `diabetes risk at or above ${W.bands.high_dm_prob} (the ${W.bands.percentile}th percentile of the ` +
        `training cohort). It never drops anyone the rules referred.`)),

    h('div', { class: 'card' },
      h('h2', {}, 'Features and learned weights'),
      h('small', {}, 'The feature space is CBAC fields only — nothing the government checklist does not already collect.'),
      h('div', { class: 'tscroll', style: 'margin-top:9px' }, h('table', { class: 'tbl' },
        h('thead', {},
          h('tr', {}, h('th', { scope: 'col' }, 'Feature'), h('th', { class: 'num', scope: 'col' }, 'Weight'))),
        h('tbody', {},
          ...coef.map(([f, w]) => h('tr', {},
            h('th', { scope: 'row' }, W.human_readable[f] || f),
            h('td', { class: 'num mono' }, w.toFixed(3))))))),
      h('small', { style: 'display:block;margin-top:9px' },
        'Every diabetes risk factor carries a positive weight; bootstrap.py aborts the build if any of ' +
        'them turns negative, because an explanation that contradicts epidemiology is worse than no ' +
        'explanation. Alcohol sits near zero, which matches its genuinely J-shaped association.')),

    h('div', { class: 'card' },
      h('h2', {}, 'Why we do not predict hypertension'),
      h('p', {}, `Hypertension AUC from CBAC fields alone is ${htn.auc} — and it should be weak. ` +
        'A BP cuff costs about ₹500 and measures it directly, so there is no prediction problem to ' +
        'solve. ML earns its place where measurement is expensive: diabetes needs a blood test, so ' +
        'triage decides who gets one. For hypertension our value is trend detection across visits.')),

    h('div', { class: 'card' },
      h('h2', {}, 'Limitations we state up front'),
      h('ul', { class: 'reasons' },
        h('li', {}, 'The demo cohort is SYNTHETIC, calibrated to published Indian NCD marginals. It is labelled on every screen. It demonstrates the mechanism, not a validated result.'),
        h('li', {}, 'CBAC item weights vary between state versions; verify against the MoHFW operational guideline before any deployment.'),
        h('li', {}, 'ABHA and eSanjeevani are integration-ready adapters, not live integrations.'),
        h('li', {}, 'Voice uses the Web Speech API. The Bhashini adapter is written but its credentials are pending.'),
        h('li', {}, 'No prospective validation. A pilot against PHC-confirmed outcomes is the next step, not a claim we make now.'))),

    h('div', { class: 'card tight' },
      h('h3', {}, 'Threshold table'),
      h('div', { class: 'tscroll' }, h('table', { class: 'tbl' },
        h('thead', {},
          h('tr', {}, h('th', { scope: 'col' }, 'Operating point'), h('th', { class: 'num', scope: 'col' }, 'Thr'),
            h('th', { class: 'num', scope: 'col' }, 'Sens'), h('th', { class: 'num', scope: 'col' }, 'Spec'),
            h('th', { class: 'num', scope: 'col' }, 'PPV'))),
        h('tbody', {},
          ...[['Youden optimal', dm.youden_optimal], ['90% sensitivity', dm.at_90pct_sensitivity],
              ['80% sensitivity', dm.at_80pct_sensitivity], ['70% sensitivity', dm.at_70pct_sensitivity]]
            .filter(([, r]) => r)
            .map(([lab, r]) => h('tr', {},
              h('th', { scope: 'row' }, lab), h('td', { class: 'num' }, r.threshold),
              h('td', { class: 'num' }, r.sensitivity), h('td', { class: 'num' }, r.specificity),
              h('td', { class: 'num' }, r.ppv)))))),
      h('small', { style: 'display:block;margin-top:8px' },
        `n = ${dm.n}, prevalence ${(dm.prevalence * 100).toFixed(1)}%. An AUC near 0.71 from a 7-field ` +
        'checklist is in line with published IDRS/CBAC validation — a suspiciously high number would ' +
        'invite more doubt, not less.')),
  );
}

// ---------------------------------------------------------------------------
// screen 6: preflight self-check
// ---------------------------------------------------------------------------

/**
 * Run this ON THE DEMO PHONE before demo day. It answers, in one screen, the
 * question that cost us an evening: is this device actually offline-capable, or
 * does it only look that way?
 *
 * Every row is measured live, not asserted.
 */
async function preflightScreen() {
  const s = capsSummary();
  const rows = Object.entries(s).map(([label, ok]) => h('tr', {},
    h('td', {}, label),
    h('td', {}, h('span', { class: `band ${ok ? 'LOW' : 'HIGH'}` }, ok ? 'YES' : 'NO'))));

  const kids = [];

  // Rejected records first, above everything else. This is where the red header
  // badge links to, and it is the only place in the app where a screening the
  // server refused can be read back. It has to be actionable, not just a count:
  // the whole point of keeping the record instead of deleting it is that somebody
  // can see what was wrong with it and re-enter it correctly.
  const bad = await api.rejectedRecords();
  if (bad.length) {
    const list = h('div', { class: 'stack' });
    const paint = (records) => list.replaceChildren(...records.map((rec) => h('div', { class: 'alert' },
      h('b', {}, rec.name || 'Unnamed'),
      ` · ${rec.village || 'Unknown'} · ${rec.screened_on || 'no date'}`,
      h('div', { class: 'alert-sub' }, rec.reason || 'Rejected by the server.'),
      ...((rec.fields || []).length
        ? [h('ul', { class: 'reasons' }, ...rec.fields.map((fl) =>
            h('li', {}, h('b', {}, `${fl.field}: `), fl.message)))]
        : []),
      h('button', {
        class: 'ghost sm', style: 'margin-top:7px',
        onclick: async () => {
          await api.discardRejected(rec.client_uuid);
          const left = await api.rejectedRecords();
          paint(left);
          await paintStatus();
          if (!left.length) toast('All rejected records cleared', 'ok');
        },
      }, 'I have re-entered this — discard'))));
    paint(bad);

    kids.push(h('div', { class: 'card' },
      h('h2', {}, `${bad.length} record(s) the server would not accept`),
      h('p', {}, 'These are out of the sync queue so they cannot block anything else, '
        + 'and they are still here so nothing is lost. Re-enter each one on the '
        + 'Screen tab with the field below corrected, then discard it.'),
      list));
  }

  kids.push(
    h('div', { class: 'card' },
      h('h2', {}, 'Preflight self-check'),
      h('p', { class: 'muted' },
        'Run this on the phone you will demo with, while online, then again in '
        + 'airplane mode. Every row is measured live.'),
      h('table', { class: 'kv' }, h('tbody', {}, ...rows)),
      h('p', { class: 'mono muted' }, `origin ${location.origin}`)),
  );

  if (!caps.offlineReload) {
    kids.push(h('div', { class: 'card' },
      h('h2', {}, 'Offline reload is not available on this origin'),
      ...secureContextFix().map((line) => h('p', {}, line)),
      h('p', {}, h('b', {}, 'What still works regardless: '),
        'filling a screening, on-device CBAC/IDRS/model scoring, and the '
        + 'IndexedDB queue. What does not: reopening the app with no network, '
        + 'and installing it to the home screen.')));
  }

  kids.push(h('div', { class: 'card' },
    h('h2', {}, 'Voice input'),
    h('p', {}, caps.voiceReason() || 'Web Speech API is available on this device.'),
    h('p', {}, h('b', {}, 'Voice needs a network even when supported. '),
      'Chrome streams the audio to Google for recognition, so the microphone '
      + 'cannot work in airplane mode. Demo voice BEFORE going offline, and say '
      + 'so — an on-device Kannada ASR is future work, not a shipped feature.')));

  return h('div', {}, ...kids);
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

const routes = [
  [/^#\/screen$/, () => screenForm()],
  [/^#\/roster$/, () => rosterScreen()],
  [/^#\/patient\/(.+)$/, (m) => patientScreen(m[1])],
  [/^#\/dashboard$/, () => dashboardScreen()],
  [/^#\/model$/, () => modelScreen()],
  [/^#\/preflight$/, () => preflightScreen()],
];

async function route() {
  const hash = location.hash || '#/screen';
  // The result card belongs to one screening on one screen. Leaving it in state
  // would resurrect a previous patient's score at the top of a blank form the
  // next time the ASHA opens the screening tab.
  if (!hash.startsWith('#/screen')) state.lastResult = null;
  document.querySelectorAll('nav.tabs a').forEach((a) => {
    if (hash.startsWith(a.dataset.route)) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) {
      try {
        view.replaceChildren(await fn(m));
      } catch (e) {
        console.error(e);
        view.replaceChildren(h('div', { class: 'card' },
          h('h2', {}, 'Something went wrong'),
          h('p', { class: 'mono' }, String(e.message || e))));
      }
      window.scrollTo(0, 0);
      return;
    }
  }
  location.hash = '#/screen';
}

window.addEventListener('hashchange', route);

(async function boot() {
  // Print the capability matrix on every boot. When someone reports "offline
  // doesn't work", this is the first thing to ask them for.
  try { console.table ? console.table(capsSummary()) : console.info(capsSummary()); } catch {}
  try {
    await api.loadModel();
  } catch {
    view.replaceChildren(h('div', { class: 'card' },
      h('h2', {}, 'Model not loaded'),
      h('p', {}, 'The app needs to fetch model weights once (about 2 KB) before it can score offline. ' +
                 'Connect briefly and reload — after that it works with no network.')));
    return;
  }
  await paintStatus();
  await route();
  // Opportunistic sync on regaining connectivity, so the queue drains without
  // the ASHA having to remember to press anything.
  window.addEventListener('online', async () => {
    try { const r = await api.syncNow(); if (r.applied) toast(`Auto-synced ${r.applied}`, 'ok'); } catch {}
    await paintStatus();
  });
})();

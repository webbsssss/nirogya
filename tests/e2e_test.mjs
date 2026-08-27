/**
 * End-to-end test of the real front-end against the real server.
 *
 * This drives web/js/app.js — the actual shipped code, not a copy — through the
 * exact sequence we will perform on stage:
 *
 *   1. cold boot, model weights fetched once
 *   2. AIRPLANE MODE: fill the CBAC form, score on-device, save
 *   3. queue badge appears, nothing is lost
 *   4. reconnect, auto-sync drains the queue
 *   5. pressing Sync a second time changes nothing (idempotent)
 *   6. the band the PHONE computed equals the band the SERVER computed
 *   7. queue -> patient detail -> trend, district dashboard, model card
 *   8. offline again: cached reads render with an explicit staleness notice
 *
 * Step 6 is the one that matters most. tests/parity_test.js already proves
 * risk.js and risk.py agree on 2100 synthetic cases, but this proves it through
 * the real request path — form values, JSON serialisation, SQLite round-trip and
 * all. That is where a field-name typo would hide.
 *
 * Usage:  ORIGIN=http://127.0.0.1:8012 node tests/e2e_test.mjs
 */

import { installDom } from './dom_shim.mjs';

const ORIGIN = process.env.ORIGIN || 'http://127.0.0.1:8000';
const APP = new URL('../web/js/app.js', import.meta.url).href;

let pass = 0;
const fails = [];

function ok(cond, label, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fails.push(label + (detail ? ` — ${detail}` : '')); console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, label) => ok(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until fn() returns truthy, or fail loudly. Rendering is async.
 *  10s, not 2s: a cold ESM graph plus a just-started server took over 4s once,
 *  and a flaky test that cries wolf the night before a demo is worse than no
 *  test — people start ignoring it. */
async function until(fn, label, ms = 10000) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = false; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await sleep(25);
  }
}

process.on('unhandledRejection', (e) => {
  fails.push(`unhandled rejection: ${e && e.message}`);
  console.log('  FAIL unhandled rejection —', e);
});

const dom = installDom({ origin: ORIGIN, online: true });
const api = (p) => fetch(ORIGIN + p).then((r) => r.json());

// Keep a handle on the real fetch so we can simulate a dead network later.
const liveFetch = globalThis.fetch;
const deadFetch = () => Promise.reject(new Error('simulated network failure'));

console.log(`\nNIROGYA end-to-end  (origin ${ORIGIN})\n${'-'.repeat(58)}`);

// ---------------------------------------------------------------------------
// 1. cold boot
// ---------------------------------------------------------------------------
console.log('\n[1] cold boot');
const appMod = await import(APP);
await until(() => dom.view.childNodes.length > 0, 'first render');
ok(!dom.text().includes('Model not loaded'), 'model weights loaded from /api/model');
ok(dom.text().includes('New screening'), 'screening form is the default route');

const partB = dom.all('.check');
eq(partB.length, 5, 'all 5 CBAC Part B red flags rendered');
const chipsets = dom.all('.chips');
ok(chipsets.length >= 5, 'chip groups rendered', `got ${chipsets.length}`);

const activeTab = dom.nav.querySelectorAll('a').filter((a) => a.getAttribute('aria-current') === 'page');
eq(activeTab.length, 1, 'exactly one nav tab marked current');

// REGRESSION GUARD for the silent-degradation bug. Node has no service worker
// and window.isSecureContext is undefined, so this shim is exactly the case that
// broke on the phone: an origin where offline reload CANNOT work. The app must
// say so on screen. If someone reverts the banner, this fails.
const cap = dom.doc.getElementById('capbanner');
ok(!!cap, 'capability banner element exists in the DOM');
eq(cap.hidden, false, 'banner is VISIBLE when offline reload is unavailable');
const capText = dom.text(cap);
ok(/insecure origin|no service worker support/.test(capText),
  'banner names the real cause', capText);
ok(capText.includes('still work'),
  'banner says what DOES still work, so it informs rather than alarms', capText);
ok(cap.querySelectorAll('a').length === 1, 'banner links to the preflight fix screen');
console.log(`      banner: ${capText.slice(0, 88)}…`);

const before = await api('/api/stats');
console.log(`      server has ${before.screenings} screenings before we start`);

// ---------------------------------------------------------------------------
// 2. airplane mode: capture a screening with no network at all
// ---------------------------------------------------------------------------
console.log('\n[2] AIRPLANE MODE — fill and save with the network down');
dom.setOnline(false);
globalThis.fetch = deadFetch;

const NAME = `E2E Test ${Date.now()}`;
const inputs = dom.all('input');
const byPlaceholder = (ph) => inputs.find((i) => i.getAttribute('placeholder') === ph);

await dom.type(byPlaceholder('Patient name'), NAME);
await dom.type(byPlaceholder('Years'), 58);
await dom.type(byPlaceholder('cm'), 97);
await dom.type(byPlaceholder('Systolic'), 148);
await dom.type(byPlaceholder('Diastolic'), 94);
await dom.type(byPlaceholder('mg/dL (optional)'), 132);

// A 58-year-old man, waist 97 (7 cm over the 90 cm male cut-off), sedentary,
// both parents diabetic, current tobacco. This SHOULD come out HIGH — if it
// does not, the wiring between the form and the scorer is wrong.
await dom.chip(chipsets[0].parentNode, 'Male');          // sex
const labelled = (txt) => dom.all('.chip').find((c) => c.textContent === txt).parentNode;
await dom.chip(labelled('Sedentary'), 'Sedentary');
await dom.chip(labelled('Both'), 'Both');
await dom.chip(labelled('Current'), 'Current');

const select = dom.one('select');
select.value = 'Byndoor';
await select.dispatch('change', { target: select });

const saveBtn = dom.all('button').find((b) => b.textContent === 'Score & save');
ok(!!saveBtn, 'save button present');
await saveBtn.click();

const result = await until(() => dom.one('.result'), 'result card');
ok(dom.text(result).includes(NAME), 'result card names the patient');

const scores = result.querySelectorAll('.score');
eq(scores.length, 3, 'CBAC / IDRS / ML shown side by side');
const shown = {
  cbac: Number(scores[0].querySelectorAll('.v')[0].textContent),
  idrs: Number(scores[1].querySelectorAll('.v')[0].textContent),
  mlPct: Number(scores[2].querySelectorAll('.v')[0].textContent.replace('%', '')),
  band: result.querySelectorAll('.band')[0].textContent,
};
console.log(`      phone computed: CBAC ${shown.cbac}  IDRS ${shown.idrs}  ML ${shown.mlPct}%  ${shown.band}`);

eq(shown.band, 'HIGH', 'high-risk profile lands in the HIGH band');
ok(shown.cbac >= 4, 'CBAC >= 4 for this profile', `got ${shown.cbac}`);
ok(shown.idrs >= 60, 'IDRS >= 60 for this profile', `got ${shown.idrs}`);
ok(dom.text(result).includes('Refer to PHC'), 'referral shown with reasons');
ok(result.querySelectorAll('.driver').length >= 3, 'per-patient drivers explained');
ok(dom.text(result).includes('queued'), 'card states it was scored offline and queued');

// REGRESSION GUARD: the form must be EMPTY after a save.
//
// It was not. state.form was mutated in place and never reset, so the next
// screening opened with the previous patient's answers still in it. The ASHA
// changes the two fields that differ, presses save, and a record goes in
// carrying the last patient's village, sex and tobacco answer with a plausible
// risk score on the end of it. Nothing on screen looks wrong, which is what
// makes it worse than a crash.
//
// The inputs have to be re-queried: submit() rebuilds the form, so the handles
// captured at line 111 point at detached nodes and would pass no matter what.
const freshInputs = dom.all('input');
const freshBy = (ph) => freshInputs.find((i) => i.getAttribute('placeholder') === ph);
eq(freshBy('Patient name').value, '', 'name field is cleared for the next patient');
eq(freshBy('Years').value, '', 'age field is cleared');
eq(freshBy('cm').value, '', 'waist field is cleared');
eq(freshBy('Systolic').value, '', 'systolic field is cleared');
eq(freshBy('mg/dL (optional)').value, '', 'FBS field is cleared');
// ...and the result card is still on screen, because clearing the form must not
// throw away the score the ASHA is reading out to the patient.
ok(!!dom.one('.result'), 'the result card survives the form reset');

// ---------------------------------------------------------------------------
// 3. the queue is real and visible
// ---------------------------------------------------------------------------
console.log('\n[3] offline queue');
eq(dom.queuePill.hidden, false, 'pending-sync badge visible');
eq(dom.queuePill.textContent, '1 pending sync', 'badge shows one pending record');
// Nothing was refused, so the rejected badge must stay dark. If it lights up here
// the client is treating a queued record as permanently refused.
eq(dom.rejectPill.hidden, true, 'rejected badge stays hidden when nothing was refused');

// Take a copy of the record while it is still queued. Step 5 re-posts this exact
// payload to prove idempotency for real; once sync succeeds the client no longer
// holds it, and a client_uuid cannot be reconstructed from the server's copy.
const queuedRows = [...globalThis.indexedDB._stores.get('queue').rows.values()];
eq(queuedRows.length, 1, 'exactly one record is in IndexedDB');
const queuedItem = queuedRows[0];
ok(!!queuedItem.client_uuid, 'the queued record carries a client_uuid (the idempotency key)');
ok(queuedItem.name === NAME, 'the queued record is the one just captured');

const midway = await (async () => {
  globalThis.fetch = liveFetch;
  const s = await api('/api/stats');
  globalThis.fetch = deadFetch;
  return s;
})();
eq(midway.screenings, before.screenings, 'server has NOT received it yet (nothing leaked)');

// ---------------------------------------------------------------------------
// 4. reconnect -> auto-sync
// ---------------------------------------------------------------------------
console.log('\n[4] reconnect');
globalThis.fetch = liveFetch;
dom.setOnline(true);
dom.fire('online');

await until(async () => dom.queuePill.hidden === true, 'queue drains');
eq(dom.queuePill.hidden, true, 'badge cleared after sync');

const after = await api('/api/stats');
eq(after.screenings, before.screenings + 1, 'exactly one screening reached the server');

// ---------------------------------------------------------------------------
// 5. idempotency — a judge WILL press Sync twice
// ---------------------------------------------------------------------------
console.log('\n[5] pressing Sync again');

// An empty batch used to stand in for this, which proved only that zero records
// insert zero rows. The claim being made is stronger and specific: the SAME
// client_uuid posted a second time is recognised and ignored. That is what
// `client_uuid TEXT UNIQUE` + INSERT OR IGNORE buys, and it is the reason a lost
// response or a double tap cannot double-count a patient.
const post = (body) => fetch(`${ORIGIN}/api/sync`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const replay = await post({ screenings: [queuedItem] }).then((r) => r.json());
eq(replay.received, 1, 'the server accepted the replayed batch');
eq(replay.applied.length, 0, 'nothing was applied a second time');
ok(replay.duplicates_ignored.includes(queuedItem.client_uuid),
  'the replayed record is reported as a duplicate, by client_uuid',
  JSON.stringify(replay.duplicates_ignored));
eq(replay.errors.length, 0, 'a replay is not an error — it is the expected case');

const afterReplay = await api('/api/stats');
eq(afterReplay.screenings, after.screenings, 'the replay created no second row');

// A third time, and with the patient row already present, to be sure the guard is
// on the record rather than on "this patient is new".
const replay2 = await post({ screenings: [queuedItem] }).then((r) => r.json());
ok(replay2.duplicates_ignored.includes(queuedItem.client_uuid), 'still idempotent on the third attempt');
const found3 = await api(`/api/patients?q=${encodeURIComponent(NAME)}`);
eq(found3.patients.length, 1, 'the patient appears exactly once, not three times');

const again = await post({ screenings: [] }).then((r) => r.json());
eq(again.received, 0, 'empty queue is a no-op');
const after2 = await api('/api/stats');
eq(after2.screenings, after.screenings, 'no duplicate row created');

// ---------------------------------------------------------------------------
// 6. PHONE vs SERVER parity through the real request path
// ---------------------------------------------------------------------------
console.log('\n[6] on-device score vs server score');
const found = await api(`/api/patients?q=${encodeURIComponent(NAME)}`);
eq(found.patients.length, 1, 'patient is queryable on the server');
const srv = found.patients[0];
eq(srv.cbac_score, shown.cbac, 'CBAC matches server');
eq(srv.idrs_score, shown.idrs, 'IDRS matches server');
eq(srv.risk_band, shown.band, 'risk band matches server');
eq(Math.round(srv.ml_diabetes_risk * 100), shown.mlPct, 'ML diabetes risk matches server');
ok(srv.referral_reasons.length > 0, 'server stored the referral reasons');
ok(srv.top_drivers.length > 0, 'server stored the explanation drivers');

// ---------------------------------------------------------------------------
// 7. the other three screens
// ---------------------------------------------------------------------------
console.log('\n[7] queue / patient / dashboard / model');
dom.loc.hash = '#/roster';
await until(() => dom.all('.prow').length > 0, 'roster rows');
const rows = dom.all('.prow');
ok(rows.length > 1, `roster lists patients (${rows.length})`);
ok(dom.text().includes('Follow-up queue'), 'roster header');
const firstBand = rows[0].querySelectorAll('.band')[0].textContent;
eq(firstBand, 'H', 'highest-risk patient sorts first');

// A patient the cohort builder gave multiple visits, so the trend view has data.
dom.loc.hash = '#/patient/NRG1020';
await until(() => dom.text().includes('visit'), 'patient detail');
ok(dom.all('table.tbl').length >= 1, 'visit history table');

const detail = await api('/api/patients/NRG1020');
ok(detail.history.length >= 3, `NRG1020 has ${detail.history.length} visits`);

// How many points the FIRST chart should have. app.js draws fbs, then sbp, then
// waist_cm, skipping any series with fewer than two readings — so the expected
// count is the length of the first series that qualifies, not history.length.
const firstSeries = ['fbs', 'sbp', 'waist_cm']
  .map((k) => detail.history.map((v) => v[k]).filter((v) => v != null))
  .find((vals) => vals.length >= 2) || [];
const detailVisits = firstSeries.length;
ok(detailVisits >= 2, `the first trend series has ${detailVisits} readings to plot`);

// The trend chart, asserted on its GEOMETRY rather than its presence.
//
// `sparks.length >= 1` passed throughout the period when the charts were three
// blank boxes: document.createElement('svg') returns an HTMLUnknownElement, which
// matches `.spark` perfectly and paints nothing. So check the things that were
// actually wrong — the namespace, and the shape of the tree.
const sparks = dom.all('.spark');
ok(sparks.length >= 1, 'trend sparkline drawn', `got ${sparks.length}`);
const SVG_NS = 'http://www.w3.org/2000/svg';
const spark = sparks[0];
eq(spark.namespaceURI, SVG_NS, 'the chart is in the SVG namespace, not the HTML one');
eq(spark.tagName, 'svg', 'root element is <svg>');
ok(/^0 0 \d+ \d+$/.test(spark.getAttribute('viewBox') || ''), 'the chart declares a viewBox',
  String(spark.getAttribute('viewBox')));

const paths = spark.querySelectorAll('path');
eq(paths.length, 1, 'exactly one polyline path per chart');
const d = paths[0].getAttribute('d') || '';
eq(paths[0].namespaceURI, SVG_NS, 'the path is in the SVG namespace');
ok(/^M[\d.\s]+(L[\d.\s]+)+$/.test(d.trim()), 'the path has real numeric geometry', d.slice(0, 60));
// One point per reading, and every coordinate finite. A NaN in here renders as
// nothing at all, silently, and is the other way a chart goes blank.
const coords = d.match(/-?\d+(\.\d+)?/g) || [];
eq(coords.length, detailVisits * 2, `path has ${detailVisits} points, one per reading`);
ok(coords.every((n) => Number.isFinite(Number(n))), 'no NaN coordinates in the path');

// The dots must be SIBLINGS of the path. When the chart was built by assigning a
// markup string, <circle/> did not self-close in the HTML parser and every dot
// ended up nested INSIDE the path element — which is invisible, and is why the
// nesting is asserted and not just the count.
const circles = spark.querySelectorAll('circle');
eq(circles.length, detailVisits, 'one dot per reading');
eq(paths[0].querySelectorAll('circle').length, 0, 'dots are siblings of the path, not nested in it');
ok(circles.every((c) => Number.isFinite(Number(c.getAttribute('cx')))
  && Number.isFinite(Number(c.getAttribute('cy')))), 'every dot has finite coordinates');
ok(!!spark.getAttribute('aria-label') && spark.getAttribute('aria-label').includes('visits'),
  'the chart carries an aria-label naming the series and its values');

if (detail.alerts.length) {
  ok(dom.all('.alert').length === detail.alerts.length, 'deterioration alerts rendered');
  console.log(`      alert: ${detail.alerts[0].message}`);

  // REGRESSION GUARD. The alert delta is measured from the mean of the first TWO
  // visits, so it does not equal (last - first) in the visit table right above
  // it. That mismatch was reported as an arithmetic bug -- it wasn't, but the
  // message never said what the baseline was, so it read like one. These checks
  // fail if anyone reverts to a message that omits the baseline.
  const a0 = detail.alerts[0];
  const vals = detail.history.map((h) => h[a0.field]).filter((v) => v != null);
  const expectBase = Math.round(((vals[0] + vals[1]) / 2) * 10) / 10;
  eq(a0.from, expectBase, `alert baseline is mean of first 2 visits (${expectBase})`);
  eq(a0.delta, Math.round((a0.to - a0.from) * 10) / 10, 'alert delta = latest - baseline');
  ok(a0.delta !== Math.round((a0.to - vals[0]) * 10) / 10,
    'delta deliberately differs from (latest - first visit)',
    `first=${vals[0]} baseline=${a0.from}`);
  ok(a0.message.includes(String(a0.from)),
    'alert message states the baseline value', a0.message);
  ok(/mean of first 2 visits/.test(a0.message),
    'alert message explains what the baseline is', a0.message);
  ok(dom.all('.alert-sub').length === detail.alerts.length,
    'each alert shows the first-visit / baseline / latest reconciliation');
  ok(dom.text().includes(String(vals[0])),
    'first-visit value is visible so the arithmetic reconciles');
} else {
  console.log('      (no deterioration alert for NRG1020 in this cohort)');
}

dom.loc.hash = '#/dashboard';
await until(() => dom.all('.heatrow').length > 0, 'village heatmap');
const villages = await api('/api/villages');
eq(dom.all('.heatrow').length, villages.villages.length, 'one heatmap row per village');
eq(dom.all('.kpi').length, 4, 'four headline KPIs');
ok(dom.text().includes(villages.recommended_camp), `camp recommendation names ${villages.recommended_camp}`);
ok(dom.text().includes('Recommended next mobile health camp'), 'operational recommendation shown');
// The high-risk cluster in the demo cohort is SEEDED — bootstrap.py gives a few
// villages a higher deprivation multiplier so the heatmap has a gradient to rank
// instead of uniform noise. Presenting the hotspot as a finding without saying so
// invites "so you invented your own answer", so the disclosure is asserted here
// rather than left to whoever happens to be narrating.
ok(dom.text().includes('deliberate high-risk cluster'),
  'the dashboard discloses that the demo cluster is seeded');

dom.loc.hash = '#/model';
await until(() => dom.text().includes('Model card'), 'model card');
const stats = await api('/api/stats');
ok(dom.text().includes(String(stats.model.diabetes_auc)), `model card states AUC ${stats.model.diabetes_auc}`);
ok(dom.text().includes('FLOOR the model cannot override'), 'safety architecture explained');
ok(dom.text().includes('Limitations we state up front'), 'limitations disclosed');
// The AUC is computed ON the synthetic cohort, so it shows the method recovers the
// structure the generator encoded — it is not a performance estimate for real
// patients. Stating that is what separates a defensible number from a circular
// one, and it is the first thing a clinician judge will probe.
ok(dom.text().includes('measured ON the synthetic cohort'),
  'the model card states the AUC is in-sample to the synthetic cohort');
ok(dom.text().includes('SYNTHETIC'), 'synthetic data disclosed on the model card');

// The screen a teammate opens on the demo phone to find out whether the device
// is really offline-capable. It must render, and it must be honest: under Node
// there is no service worker, so the offline-reload row has to read NO.
dom.loc.hash = '#/preflight';
await until(() => dom.text().includes('Preflight self-check'), 'preflight screen');
const prows = dom.all('table.kv tr');
ok(prows.length >= 7, `preflight measures every capability (${prows.length} rows)`);
const preflight = dom.text();
ok(/Offline reload[^Y]*NO/.test(preflight.replace(/\s+/g, ' ')),
  'preflight reports offline reload as NO on this origin — it does not pretend');
ok(preflight.includes('chrome://inspect') && preflight.includes('chrome://flags'),
  'preflight gives both secure-context fixes');
ok(/Chrome sends|streams audio|needs a network/i.test(preflight),
  'preflight warns that voice needs a network even when supported');

// ---------------------------------------------------------------------------
// 8. offline reads fall back to cache, and SAY they did
// ---------------------------------------------------------------------------
console.log('\n[8] offline read fallback');
globalThis.fetch = deadFetch;
dom.setOnline(false);
dom.loc.hash = '#/screen';
await until(() => dom.text().includes('New screening'), 'form still renders offline');
ok(true, 'screening form works with the network down');

dom.loc.hash = '#/dashboard';
await until(() => dom.all('.heatrow').length > 0 || dom.text().includes('needs a connection'), 'dashboard offline');
ok(dom.all('.heatrow').length > 0, 'dashboard served from cache');
ok(dom.text().includes('Offline — showing data cached at'), 'staleness is disclosed, not hidden');

globalThis.fetch = liveFetch;
dom.setOnline(true);

// ---------------------------------------------------------------------------
// 9. the HTTP surface: what a hostile or clumsy request gets back
// ---------------------------------------------------------------------------
// Everything above drives the app the way it is meant to be driven. This drives
// it the way a judge with a browser console, or a scanner, or a fat-fingered URL
// will. Two properties are being asserted:
//
//   a 400 is a right answer and a 500 is a wrong one. A 500 means an unhandled
//   Python exception reached the socket, and the traceback that goes with it names
//   files, line numbers and SQL. That is a finding.
//
//   one bad record cannot harm a good one. The batch endpoint takes whatever a
//   phone that has been offline for a week hands it, and a single corrupt row in
//   that batch must not cost the other forty.
console.log('\n[9] HTTP surface — malformed, hostile and out-of-range requests');

const raw = (p, opts) => fetch(ORIGIN + p, opts);
const LEAKS = ['Traceback', 'File "', 'sqlite3', 'KeyError', 'ValueError', 'TypeError',
               'app.py', 'validate.py', 'risk.py', 'nirogya.db'];

/** A request must answer with the status we intend, and must not describe our
 *  internals while doing it. */
async function safeStatus(path, opts, want, label) {
  const r = await raw(path, opts);
  const body = await r.text();
  ok(r.status === want, `${label} -> ${want}`, `got ${r.status}: ${body.slice(0, 120)}`);
  const leaked = LEAKS.filter((s) => body.includes(s));
  ok(leaked.length === 0, `${label}: no internals in the response`, leaked.join(', '));
  return { status: r.status, body };
}

// --- query-string bounds (clean_limit / clean_query) ---
for (const [qs, why] of [
  ['limit=abc', 'non-numeric limit'],
  ['limit=-1', 'negative limit'],          // SQLite reads a negative LIMIT as "no limit"
  ['limit=0', 'zero limit'],
  ['limit=99999999', 'limit past the cap'],
  ['limit=1e9', 'limit in exponent notation'],
  ['limit=nan', 'limit of NaN'],
  ['band=NOPE', 'unknown risk band'],
  [`q=${'x'.repeat(500)}`, 'over-long search string'],
]) {
  await safeStatus(`/api/patients?${qs}`, undefined, 400, why);
}
// ...and the shapes that are legitimate still work, so the bounds above are a
// filter and not a wall.
for (const qs of ['limit=1', 'limit=500', 'band=high', 'band=HIGH', 'refer=1', 'q=Prakash']) {
  const r = await raw(`/api/patients?${qs}`);
  ok(r.status === 200, `?${qs} is accepted`, `got ${r.status}`);
}

// --- path segments ---
await safeStatus('/api/patients/NOPE999999', undefined, 404, 'unknown patient id');
await safeStatus('/api/patients/..%2f..%2fetc%2fpasswd', undefined, 400, 'path traversal in a patient id');
await safeStatus('/api/patients/%00', undefined, 400, 'NUL byte in a patient id');
await safeStatus(`/api/patients/${'A'.repeat(200)}`, undefined, 400, 'over-long patient id');
await safeStatus('/api/nope', undefined, 404, 'unknown API route');
await safeStatus('/js/', undefined, 404, 'directory listing of /js/');
await safeStatus('/../server/app.py', undefined, 404, 'traversal out of the web root');

// --- request bodies ---
const jpost = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body });

await safeStatus('/api/sync', jpost('{nope'), 400, 'malformed JSON body');
await safeStatus('/api/sync', jpost('[]'), 400, 'JSON array instead of an object');
await safeStatus('/api/sync', jpost('"a string"'), 400, 'JSON string instead of an object');
await safeStatus('/api/sync', jpost('{"screenings": "not a list"}'), 400, 'screenings is not a list');
await safeStatus('/api/sync', jpost(JSON.stringify({ screenings: new Array(600).fill({}) })),
  400, 'batch over the 500-record cap');
// json.loads accepts bare NaN by default. A NaN age makes every comparison in
// cbac_score() false — so it scores as the OLDEST band — and json.dumps then emits
// a bare NaN that the phone's JSON.parse cannot read at all.
const nanBody = (v) => jpost(`{"screenings":[{"client_uuid":"e2e-${v}","name":"NaN probe",`
  + `"age":${v},"sex":"M","waist_cm":95,"tobacco":"never","activity_level":"sedentary",`
  + '"active_minutes_week":0}]}');
for (const v of ['NaN', 'Infinity', '-Infinity']) {
  const r = await raw('/api/sync', nanBody(v));
  const body = await r.text();
  ok(r.status < 500, `${v} in a numeric field does not 500`, `got ${r.status}`);
  // The invariant is not "the word NaN never appears" — it appears inside the
  // error message, quoted, which is fine and useful. It is that the RESPONSE
  // ITSELF still parses. json.dumps emits a bare NaN token by default, and
  // JSON.parse on the phone throws on it, so the ASHA would see a sync failure
  // with no reason attached instead of a field error she can act on.
  let parsed = null;
  try { parsed = JSON.parse(body); } catch (e) { parsed = null; }
  ok(parsed !== null, `the ${v} rejection is still parseable JSON`, body.slice(0, 140));
  ok(!/[:[,]\s*(-?(NaN|Infinity))\s*[,}\]]/.test(body),
    `${v} never appears as a bare JSON value`, body.slice(0, 140));
  ok(!body.includes('"applied": [{'), `${v} was not scored and stored`, body.slice(0, 140));
}

// --- batch isolation: one bad record must not cost the good ones ---
const stamp = queuedItem.client_uuid.slice(0, 8);
const goodItem = { ...queuedItem, client_uuid: `e2e-iso-good-${stamp}`, name: `E2E Isolation ${stamp}` };
delete goodItem.patient_id;     // let the server assign a fresh one
const isoBefore = await api('/api/stats');
const iso = await post({
  screenings: [
    { client_uuid: `e2e-iso-bad-${stamp}`, name: 'E2E bad', age: 'fifty', sex: 'Z',
      waist_cm: 95, tobacco: 'vape', activity_level: 'teleport', active_minutes_week: -3 },
    goodItem,
  ],
}).then((r) => r.json());
eq(iso.received, 2, 'the mixed batch was received');
ok(iso.applied.some((a) => a.client_uuid === goodItem.client_uuid),
  'the VALID record in a mixed batch was applied', JSON.stringify(iso.applied));
eq(iso.errors.length, 1, 'exactly one item errored');
eq(iso.errors[0].client_uuid, `e2e-iso-bad-${stamp}`, 'the error names the offending record');
eq(iso.errors[0].permanent, true, 'a bad enum is permanent, not something to retry forever');
ok(iso.errors[0].fields.length >= 3, 'every bad field is reported at once, not just the first',
  JSON.stringify(iso.errors[0].fields));
ok(iso.errors[0].fields.some((f) => f.field === 'age'), 'the age error is attributed to `age`');
const isoAfter = await api('/api/stats');
eq(isoAfter.screenings, isoBefore.screenings + 1, 'exactly one row from the mixed batch');

// --- security headers, on the response a browser actually loads ---
const shellRes = await raw('/');
const csp = shellRes.headers.get('content-security-policy') || '';
ok(csp.includes("default-src 'self'"), 'CSP sent on the app shell', csp.slice(0, 60));
ok(csp.includes("script-src 'self'") && !/script-src[^;]*unsafe-inline/.test(csp),
  "script-src is 'self' with no unsafe-inline", csp);
ok(csp.includes("object-src 'none'") && csp.includes("frame-ancestors 'none'"),
  'object-src and frame-ancestors are locked down');
eq(shellRes.headers.get('x-content-type-options'), 'nosniff', 'nosniff sent');
eq(shellRes.headers.get('x-frame-options'), 'DENY', 'clickjacking blocked');
eq(shellRes.headers.get('referrer-policy'), 'no-referrer',
  'no-referrer, so a patient id in the URL is never sent to a third party');
// No CORS header, deliberately: nothing off-origin should be able to read the API
// and this app never needs it. A wildcard here would let any page a health worker
// happens to visit enumerate the register.
ok(!(await raw('/api/stats')).headers.get('access-control-allow-origin'),
  'the API sends no Access-Control-Allow-Origin');
// Permissions-Policy is deliberately absent: a restrictive one would switch off
// the microphone that voice input needs. Asserted so nobody adds it as "hardening"
// and silently breaks the Kannada voice demo.
ok(!shellRes.headers.get('permissions-policy'),
  'no Permissions-Policy, so the microphone stays available for voice input');

// --- stored markup stays data ---
// There is no innerHTML anywhere in the client (asserted statically by
// shell_test.mjs), so a name containing a tag is rendered as literal text. Prove
// the round trip instead of asserting it: store one and read it back unchanged.
const XSS = '<img src=x onerror=alert(1)>';
await post({ screenings: [{ ...goodItem, client_uuid: `e2e-xss-${stamp}`, name: XSS }] });
const probe = await api(`/api/patients?q=${encodeURIComponent('<img')}`);
const stored = probe.patients.find((p) => p.name === XSS);
ok(!!stored, 'a name containing markup is stored verbatim, neither stripped nor mangled');
ok(!JSON.stringify(probe).includes('&lt;img'),
  'the server does not HTML-escape on the way out — that is the renderer\'s job, and '
  + 'double-escaping would show &lt;img to the ASHA');

// And the renderer's half of that claim, through the real DOM: the roster must
// contain the text and must NOT contain an element built from it.
dom.loc.hash = '#/roster';
await until(() => dom.all('.prow').length > 0, 'roster reloaded');
const search = dom.all('input').find((i) => i.getAttribute('placeholder')
  && /search/i.test(i.getAttribute('placeholder')));
if (search) {
  await dom.type(search, '<img');
  await until(() => dom.text().includes('<img') || dom.text().includes('No patients'), 'xss search');
  ok(dom.text().includes(XSS), 'the markup name renders as text in the roster');
  ok(dom.all('img').length === 0, 'no <img> element was created from it');
}

// ---------------------------------------------------------------------------
console.log(`\n${'-'.repeat(58)}`);
if (fails.length) {
  console.log(`FAILED — ${pass} passed, ${fails.length} failed\n`);
  fails.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log(`ALL ${pass} CHECKS PASSED\n`);
process.exit(0);

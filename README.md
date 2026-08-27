# Nirogya

**AI-enabled early screening and remote monitoring of chronic diseases for rural Karnataka.**
Team SANKALP · Problem statement IHSIH007 · MAHE Internal Hackathon, 28–29 Aug 2026

An offline-first PWA that ASHA workers use to run the government's existing CBAC screening, scores risk **on the phone with no network**, and rolls the results up into a district heatmap that tells a taluk health officer where to send the next mobile camp.

---

## Run it

Two commands. No `pip install`, no `npm install`, no internet.

```bash
cd nirogya
python3 server/bootstrap.py     # generate cohort, train model, build DB  (~20s)
python3 server/app.py           # serve on http://localhost:8000
```

Requires Python 3.8+ for the server and Node 18+ for the tests only.

On the laptop, open `http://localhost:8000` and everything works. **On a phone it does not, unless you do one extra step first** — the LAN URL the server prints is not a secure context, so the browser silently disables offline caching and the microphone. Read the next section before you touch a phone; this is not optional and it is where an evening was lost.

To verify everything before you demo:

```bash
./run_all.sh                    # build + all tests, must print ALL GREEN
bash run_all.sh                 # same thing, if the executable bit was lost
```

Use the second form after downloading a zip: archives do not carry the Unix
executable bit, so `./run_all.sh` gives `Permission denied` until you either run
it through `bash` or `chmod +x run_all.sh`.

If `run_all.sh` is not green, do not demo that build.

### Options

| Variable | Purpose |
|---|---|
| `PORT=8010` | Serve on a different port |
| `NIROGYA_DB=server/other.db` | Put the SQLite file elsewhere — use this if you hit `disk I/O error`, which happens on some network drives and container mounts where SQLite can't take its locks |

Prefer a **repo-relative** path for `NIROGYA_DB`. Git Bash / MSYS rewrites
POSIX-looking absolute paths when handing an environment variable to
`python.exe`, so `NIROGYA_DB=/tmp/n.db` reaches the server as
`C:/Users/.../tmp/n.db` — it still works, but not where you think it did, which
is confusing when you go looking for the file.

---

## Running it on the demo phone — read this first

Browsers restrict service workers and the microphone API to **secure contexts**: `https://`, `http://localhost`, `http://127.0.0.1`, or an origin you explicitly allowlist. The LAN URL (`http://192.168.x.x:8000`) is none of those. On that origin `'serviceWorker' in navigator` is simply `false` and `window.webkitSpeechRecognition` is `undefined`, so both features are skipped by the browser before our code gets a say.

An earlier version of this README told you to open the LAN URL on your phone and add it to the home screen. That was wrong. It produces an app that looks complete, screens patients correctly, and then does nothing at all when you put the phone in airplane mode and reload — which is the single moment the demo is built around.

Pick one of these. **A** is more reliable and is what you should use on stage.

**Fix A — USB port forwarding (a real secure context).**

1. Phone: Settings → About → tap Build number 7× → Developer options → USB debugging ON.
2. Connect by USB, accept the debugging prompt on the phone.
3. Laptop Chrome: open `chrome://inspect` → **Port forwarding…** → check *Enable*, add `8010` → `localhost:8010`.
4. On the **phone**, open `http://localhost:8010`. Add to Home screen from there.

The phone is now on a genuine secure context: service worker registers, offline reload works, home-screen install works, microphone works.

**Fix B — allowlist the LAN origin (no cable).**

On the phone open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, paste the exact origin (`http://192.168.1.23:8000`, scheme and port included), set the flag to **Enabled**, relaunch Chrome.

Faster to set up, but it is per-device, per-origin, and it resets — if the laptop's IP changes on hackathon Wi-Fi you have to redo it. Don't rely on it for the live demo.

### Verify, don't assume — open `#/preflight`

The app has a self-check screen at `#/preflight`. It measures seven capabilities live on whatever device you are holding and reports each as YES/NO:

```
Secure context / Service worker supported / Service worker controlling page /
IndexedDB (offline queue) / Offline capture / Offline reload / Voice input
```

If **Offline reload** is NO, airplane mode will not work and the app says so in an amber banner on every screen rather than pretending. `boot()` also prints the same table to the console. Run preflight on the demo phone once while online, then again in airplane mode, before demo day.

### Two different things called "offline"

| | Needs | Works on the LAN URL? |
|---|---|---|
| **Offline capture** — fill a form, score CBAC/IDRS/model on-device, queue to IndexedDB, sync later | IndexedDB + the already-loaded page | **Yes** |
| **Offline reload** — close the app or reload with no network and have it come back | Service worker → secure context | **No** |

The app's genuine claim is that *scoring happens on the device with no server round-trip*, and that is true everywhere. Reopening the app with no network needs the service worker. Say it that precisely to judges; conflating the two is what made this README overclaim.

### Voice needs a network. Always.

Chrome's Web Speech API streams the audio to Google for recognition — it is not on-device. So voice cannot work in airplane mode even after you fix the secure context. **Demo the microphone before you go offline**, and if asked, say plainly that on-device Kannada ASR (or Bhashini) is the production path and is not shipped here. The mic button explains this itself instead of failing silently: offline it says voice needs a network, and on an insecure origin it says the browser blocked the API.


---

## What's here

```
server/
  bootstrap.py     synthetic cohort + logistic-regression training + DB build
  risk.py          CBAC, IDRS, model inference, banding   <- SOURCE OF TRUTH
  validate.py      request validation — nothing reaches risk.py unchecked
  app.py           JSON API + static file server (stdlib only)
  check_cohort.py  plausibility gate: prevalences, risk-factor gradients
web/
  index.html       app shell
  js/risk.js       line-for-line JS port of risk.py — this is what scores offline
  js/app.js        hash router + 6 screens
  js/db.js         IndexedDB: offline queue + read cache
  js/api.js        offline-first server access
  js/capability.js what this device can actually do, and WHY not when it can't
  js/voice.js      Kannada voice, provider-swappable (Web Speech / Bhashini)
  js/sw-register.js  service-worker registration — a file rather than an inline
                   <script>, so the CSP can be script-src 'self' with no unsafe-inline
  sw.js            service worker: precache shell, never cache /api/
tests/
  parity_test.js       risk.js == risk.py across 2,100 boundary cases
  voice_test.mjs       spoken-number and yes/no parsing, 227 assertions
  validate_test.py     server-side validation, 4,235 assertions
  shell_test.mjs       precache completeness + CSP conformance, 106 assertions
  e2e_test.mjs         full offline→queue→sync→dashboard run, 170 assertions
  dom_shim.mjs         minimal DOM+IndexedDB so the real UI code runs under Node
  gen_parity_cases.py  writes the boundary-case fixture to STDOUT (redirect it)
run_all.sh         build + every test, eight stages, one command
```

### The six screens

1. **Screen** — CBAC Part A + Part B form, mic buttons on age / waist / FBS, scores instantly on-device
2. **Queue** — follow-up list, highest risk first, filterable by village and band
3. **Patient** — visit history, fasting-glucose / BP / waist sparklines, deterioration alerts
4. **District** — KPIs, village risk heatmap, recommended next camp location
5. **Model** — the model card: AUC, operating points, coefficients, safety architecture, stated limitations
6. **Preflight** (`#/preflight`, not in the tab bar) — live capability self-check for the demo phone

---

## Architecture, and why it is this way

**Scoring runs on the phone, in JavaScript, with no network.** `web/js/risk.js` is a port of `server/risk.py`, and `tests/parity_test.js` proves they agree on every field of 2,100 boundary cases — every CBAC and IDRS threshold, both sexes, both sides of every cut-off, including the exact human-readable reason strings. That is why "offline AI" is a literal statement here rather than a slide claim.

**Logistic regression, not XGBoost, for the on-device path.** LR coefficients port to plain JavaScript and the per-feature contribution `coef × (x − mean)` is an *exact* explanation, not an approximation like SHAP. XGBoost + SHAP belongs server-side as the heavy model. Two-tier — light model in the field, heavy model on sync — is a better story than either alone and it's honest.

**The government rules are a floor the model cannot override.** CBAC ≥ 4, any CBAC Part B red flag, or IDRS ≥ 60 refers the patient regardless of what the model outputs. The model can only ever *add* a referral, never remove one. This is the strongest safety answer in the project.

**Sync is idempotent.** Every screening carries a `client_uuid` with a UNIQUE constraint and `INSERT OR IGNORE` behind it. A judge can press Sync twice, or the reconnect can be flaky, and no record duplicates. The client queues to IndexedDB *before* attempting the push, so an interrupted request cannot lose data — worst case it syncs twice, which is a no-op.

**The service worker never caches `/api/`.** Freshness and staleness reporting live in `api.js`, which can tell the user *"showing data cached at 14:32"*. A silently cached dashboard that looks live is how you confidently give a judge a wrong answer.

**No framework, no build step.** `npm` was unavailable in the environment this was built in, so a React version could not have been executed even once — and shipping an unverified demo is the failure mode this whole project is organised against. Each screen is a function returning a DOM node with no shared mutable state, so a React port is mechanical if you want one. See §4 of the battle plan before you spend time on it.

---

## Numbers (regenerate with `./run_all.sh`; don't trust this table if it disagrees)

| | |
|---|---|
| Diabetes AUC | **0.713** (prevalence 14.5%) |
| Operating point | threshold 0.10 → **80% sensitivity**, 46% specificity, PPV 0.205 |
| Youden optimal | threshold 0.13 → 70% sens / 62% spec |
| Hypertension AUC | 0.642 — deliberately weak, see the model card |
| HIGH band | diabetes probability ≥ 0.2342 (85th percentile) |
| Cohort | 1,200 patients / 1,218 screenings / 8 Udupi villages |
| CBAC ≥ 4 refers | **46.0%** of everyone screened |
| Nirogya HIGH band | **21.7%** |

**On AUC 0.713:** this is the right number to defend, not a disappointment. It is in line with published IDRS and CBAC validation for a seven-field checklist. An AUC of 0.95 from six questions invites a judge to look for leakage — and they would find it. An earlier throwaway prototype produced 0.837; **that number is dead, do not quote it.**

**On 46% vs 21.7%:** be precise, because overclaiming here is the easiest way to lose credibility. Nirogya does **not** reduce referral load and by design cannot — the deterministic rules only ever escalate. What it adds is an *ordering inside* the referral floor, so the ASHA works the top 22% first instead of facing a 46% list with no priority at all. The floor is the government's; the ordering is ours.

---

## Demo-day cheat sheet

- Recommended camp / hotspot village: **Byndoor**, 36.8% high-risk vs 21.7% district average
- Multi-visit patients for the trend screen: **NRG1020** (7 visits, +30.5 mg/dL fasting glucose), **NRG2178**, **NRG1196**
- A profile that reliably lands HIGH: age 58, male, waist 97 cm, sedentary, both parents diabetic, current tobacco → CBAC 8, IDRS 90
- **Deterioration alerts measure from the mean of the first two visits, not the first visit.** So NRG1020's fasting glucose reads 177 → 210 in the visit table (+33) while the alert says +30.5, from a baseline of 179.5. That is deliberate — one noisy opening reading should not be able to invent or hide an alert — and the alert now states the baseline and shows the reconciliation underneath. If a judge does the subtraction from the table, you have the answer.
- The airplane-mode moment is the most valuable thing in the demo — but it only works if `#/preflight` says **Offline reload: YES** on that device. Check it, on that phone, on that Wi-Fi. And demo the mic **before** you switch airplane mode on.

Full choreography, judge Q&A and failure drills: `../NIROGYA_3DAY_BATTLE_PLAN.md` §6–§7.

---

## Testing

```bash
./run_all.sh                          # everything: eight stages, must print ALL GREEN

# Individual suites. No build step, no npm, no server needed for these four.
node tests/parity_test.js             # risk.js == risk.py
node tests/voice_test.mjs             # spoken-number and yes/no parsing
node tests/shell_test.mjs             # precache completeness + CSP conformance
python3 tests/validate_test.py        # server-side request validation
python3 server/check_cohort.py        # cohort plausibility only

# Regenerate the parity fixture. Write to a TEMP file and move it into place.
# Do NOT redirect straight onto the fixture: the shell truncates a redirect
# target BEFORE running the command, so `> tests/parity_cases.json` replaces
# 2.5 MB of cases with 0 bytes the instant the generator fails — and
# parity_test.js then reports a JSON parse error that points at the parser
# instead of at the generator that actually broke. This cost us the fixture once.
python3 tests/gen_parity_cases.py > tests/parity_cases.json.tmp \
  && mv tests/parity_cases.json.tmp tests/parity_cases.json

# The e2e suite WRITES to whatever database the server is pointed at, and it
# deliberately stores a patient whose name contains markup to prove the renderer
# escapes it. Serve a throwaway COPY, never the demo database: those rows score
# HIGH, and the roster sorts by descending risk, so they land above every real
# patient on the dashboard. run_all.sh does this for you.
cp server/nirogya.db server/nirogya_e2e.db
NIROGYA_DB=server/nirogya_e2e.db python3 server/app.py &
ORIGIN=http://127.0.0.1:8000 node tests/e2e_test.mjs
```

Three things about these tests are worth knowing, because they are what makes the numbers above trustworthy:

**`bootstrap.py` aborts the build on a nonsensical coefficient.** If age, waist excess, family history, tobacco or inactivity comes out *negative* for diabetes risk, no weights are written. This gate caught three real bugs. Every instance had the same root cause: a model feature with no matching term in the data generator, or a term using a different definition than the scorer uses. **If you add a feature to the model, add the matching term to the generator with the identical definition.** Alcohol is exempt and sits at −0.078, matching its J-shaped association in the literature.

**`check_cohort.py` checks direction, not just magnitude.** It asserts that diabetes prevalence is higher among smokers, the inactive, those with family history, those above the waist cut-off, and those over 50. A cohort with plausible headline percentages but inverted gradients would train a model that explains itself backwards on stage.

**The tests have been mutation-tested.** Three deliberate bugs were injected into the parity test's subject (CBAC boundary `<=`→`<`, removed Part B escalation, absolute waist instead of sex-adjusted excess) and three into the e2e test's (dropped the offline queue write, diverged the client waist cut-off from the server, silently hid the staleness notice). All six were caught. A test suite nobody has seen fail is not evidence of anything.

---

## Limitations — stated here and on the Model screen

- **The cohort is SYNTHETIC**, calibrated to published Indian NCD marginals. It is labelled on every screen of the app. It demonstrates the mechanism; it is not a validated result.
- CBAC item weights vary between state versions. **Verify against the MoHFW NP-NCD operational guideline** before anyone quotes them — every downstream number depends on it.
- ABHA and eSanjeevani are integration-ready adapters, not live integrations.
- **Offline reload requires a secure context, and voice requires a network.** Scoring is genuinely on-device everywhere; reopening the app with no network needs the service worker, and Chrome's speech recognition is a cloud service. Both are surfaced in the app (amber banner + `#/preflight`) rather than left to fail silently. See "Running it on the demo phone".
- Voice uses the Web Speech API. The Bhashini adapter's interface is complete; its transport is deliberately unimplemented rather than faked, because the credentials may not arrive in three days. On-device Kannada ASR is future work.
- No prospective validation. A pilot against PHC-confirmed outcomes is the next step, not a claim to make now.
- No authentication, no encryption at rest, no DPDP consent flow implemented. Consent-first is in the pitch as a design commitment, not as shipped code — say so if asked.

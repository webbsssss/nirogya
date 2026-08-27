# Nirogya — code walkthrough

This is for the team, not the judges. The point is that every one of us can
explain the code from understanding rather than memory, because the failure mode
that actually loses marks is a judge pointing at a line and the room going quiet.

**How to use it.** Read a section with the file open beside it — the file is the
truth, this is a map. Then have a teammate ask you the "if they push" question
without you looking. If you can't answer it in your own words, you don't own that
section yet.

Nothing here is a script to recite. If you find yourself quoting these sentences
verbatim on stage it will sound like it, and a follow-up question will expose it.

---

## The whole system in one breath

An ASHA screens a patient on a phone with no signal. The phone computes the score
itself, saves it locally, and syncs when a connection appears. The score is the
government's CBAC and IDRS checklists — which decide *whether* to refer — plus a
small logistic-regression model that decides *what order* to work the referrals
in. The rules can always add a referral; the model can never remove one.

If you only keep five things:

1. `server/risk.py` is the source of truth. `web/js/risk.js` is its port, and the
   parity test proves they agree on 2,100 cases.
2. The deterministic rules are a **floor**. The model only reorders inside it.
3. The client form is a usability feature, not a security boundary. That is why
   `server/validate.py` exists.
4. A screening is queued to IndexedDB *before* any network attempt, so it cannot
   be lost.
5. AUC 0.713 is the number we defend. **0.837 is dead — never say it.**

---

## 1. The referral floor — the safety answer

**Read:** `server/risk.py`, function `assess()`.

Three things can refer a patient, and any of them is enough: CBAC ≥ 4, any CBAC
Part B symptom flag, or IDRS ≥ 60. All three come from published government /
MDRF criteria, not from us. The model's probability is computed alongside them and
appended to the reasons, but look at the branch order: `refer` is
`bool(reasons)` — it is true if *any* deterministic rule fired, and the model has
no way to empty that list.

Banding then sorts *within* the referred set:

- **HIGH** — a Part B flag (possible TB, COPD or cancer: urgent whatever the
  score says), or referred *and* in the top model-risk slice.
- **MODERATE** — referred, not top slice.
- **LOW** — no referral criterion met at all.

**If they push — "what happens when your AI is wrong about someone?"** The worst
it can do is over-refer. It cannot under-refer relative to current practice,
because it never removes a rule-based referral. Point at the `if partb: band =
"HIGH"` branch — the model isn't even consulted there.

**If they push — "so is the band a second gate that filters people out?"** No.
Nobody referred by CBAC or IDRS is ever dropped to LOW. Read the `elif reasons:`
branch: if any rule fired, the floor is MODERATE.

---

## 2. Offline scoring, and how we know it's correct

**Read:** `web/js/risk.js` next to `server/risk.py`, then `tests/parity_test.js`.

The phone fetches ~2 KB of coefficients once (`api.js`, `loadModel()`), caches
them in IndexedDB, and from then on scores with no network at all. That is why
"offline AI" is literal here and not a slide claim.

The risk is drift: two implementations of the same arithmetic that quietly
disagree. So `tests/parity_cases.json` holds 2,100 cases — every CBAC and IDRS
threshold, both sexes, both sides of every cut-off — and the parity test asserts
`risk.js` and `risk.py` agree on **every field**, including the human-readable
reason strings.

Note the detail in `describe_driver()`: numbers are formatted explicitly
(`:.1f`, `int()`) rather than relying on default repr. That is not fussiness —
without it Python prints `99.0` where JavaScript prints `99`, and string parity
breaks.

**If they push — "how do you know the phone agrees with the server?"** Two
answers, and give both. The parity suite proves it on 2,100 synthetic cases; and
step 6 of `tests/e2e_test.mjs` proves it through the real request path, comparing
the band the phone computed against the band the server computed for the same
patient. The second one is what would catch a field-name typo that the first
would miss.

---

## 3. Why logistic regression, not XGBoost

**Read:** `server/risk.py`, `predict()`.

Two reasons, and the second is the better one.

It ports to plain JavaScript in a few lines, so it can run on the phone.

And the per-feature contribution `w × z` is an **exact** decomposition of the
logit, not an approximation. SHAP on a boosted tree gives you an estimate;
this gives you the actual arithmetic. When the app says "Waist 97.0 cm — 7.0 cm
above the 90 cm cut-off — increases risk", that is the real term, and it sums to
the logit.

**If they push — "why not a stronger model?"** Because the heavy model belongs
server-side on sync, and we would rather ship the light one that provably runs in
the field than demo a strong one that needs a network. Say the two-tier design out
loud — light model in the field, heavy model on sync — it is a better answer than
either alone.

**If they push — "why is `waist_excess` not just waist?"** This is a good
question and there is a real answer. Men's baseline waist is higher, and `is_male`
is already a feature, so with absolute waist the waist coefficient goes *negative*
to compensate — and the explainability panel then tells a judge that a larger
waist reduces diabetes risk. Sex-adjusted excess is both clinically correct and
numerically stable. `bootstrap.py` aborts the build if any of these signs
regresses, which is how we know.

---

## 4. The numbers, and what we refuse to claim

**Read:** the Numbers table in `README.md`; regenerate with `./run_all.sh`.

Diabetes AUC **0.713** at 14.5% prevalence. This is the right number to defend,
not an apology. It is in line with published IDRS and CBAC validation for a
seven-field checklist. An AUC of 0.95 from six questions invites a judge to hunt
for leakage, and they would find it.

Hypertension AUC 0.642 is deliberately weak and the model card says so, because
CBAC fields alone genuinely don't carry hypertension well.

**The 46% vs 21.7% point — be precise here, this is the easiest place to lose
credibility.** CBAC ≥ 4 alone refers 46% of everyone screened. We do **not**
reduce that, and by design we cannot, because the deterministic rules only
escalate. What we add is an ordering *inside* the floor, so the ASHA works the top
22% first instead of facing a 46% list with no priority. The floor is the
government's; the ordering is ours.

**If they push — "so what does your model actually buy?"** Triage order under a
fixed capacity constraint. A PHC cannot absorb 46% of the adult population; the
question is who gets seen first, and that is the question we answer.

---

## 5. Why `validate.py` exists — the trust boundary

**Read:** `server/validate.py` module docstring, then `_number()`.

The form in `app.js` already enforces every range. That is usability, not
security: it lives on the client, and anyone can post straight to `/api/screen`.
Before this module the server handed whatever arrived to `risk.py`, and there were
three failure classes:

| Payload | Before |
|---|---|
| `{"age": "fifty"}` | `TypeError` inside `cbac_score` → HTTP 500 |
| `{"tobacco": "vape"}` | `KeyError` inside `cbac_score` → HTTP 500 |
| `{"age": -5, "waist_cm": 0}` | **scored happily and stored** |

The third is the one that matters. A 500 is loud and gets fixed. A plausible-
looking row in a clinical table is silent and permanent.

Two details worth being able to explain, because they look like trivia and aren't:

- `isinstance(raw, bool)` is checked **before** the numeric check, because
  `isinstance(True, int)` is `True` in Python — so `{"age": true}` would otherwise
  be accepted as age 1.
- NaN and Infinity are rejected explicitly, because `json.loads` accepts the bare
  literals `NaN` and `Infinity` by default. A NaN age makes every comparison in
  `cbac_score()` false, so it silently scores as the *oldest* band, and then
  `json.dumps` emits a bare `NaN` token that the phone's `JSON.parse` cannot read
  at all — the ASHA gets a failure with no reason attached.

A rejection names the field and what was wrong with it, and collects *every* bad
field at once rather than stopping at the first. Someone re-entering a record
should not discover the problems one submit at a time.

**If they push — "how do you know nothing gets through?"**
`tests/validate_test.py` asserts the actual theorem over thousands of generated
payloads: for any payload, either validation rejects it, or `risk.assess()`
survives it. 2,436 rejected and 1,564 accepted-and-scored on the last run, so both
branches are genuinely exercised — a test where everything lands on one side would
prove nothing.

---

## 6. The sync contract — the worst bug we had

**Read:** `server/app.py` → `sync()`, then `web/js/api.js` → `syncNow()`. Both
halves, or the story doesn't make sense.

Idempotency is easy to state: `client_uuid` has a `UNIQUE` constraint and inserts
use `INSERT OR IGNORE`, so pressing Sync twice is a no-op. The database enforces
it, not just a pre-check.

The interesting part is the failure that isn't dramatic. The server's sync loop
had no `try/except`, so **one** malformed queued record — a single bad enum was
enough — raised out of `screen()`, out of `do_POST`, and returned HTTP 500 for the
entire batch. The valid records in that batch had already been committed. But the
500 carried no `applied` list, and the client's first line was
`if (!r.ok) throw` — so it threw before reading the body, `dequeue()` never ran,
and the queue kept every record the server had just successfully stored. The
pending badge stayed lit, the ASHA pressed Sync again, and the same item failed
identically forever. One bad record froze an entire phone's sync, and neither side
said why.

The fix is on both sides:

- Server: every item is isolated, the batch always returns a per-item verdict —
  `applied`, `duplicates_ignored`, `errors[]` — and `errors[].permanent`
  distinguishes "a human needs to fix this" from "retry later".
- Client: **the body is parsed before the status is checked.** A response with a
  verdict in it is worth reading whatever the status line says. The status only
  matters if nothing at all was accounted for.

**If they push — "what happens to a record the server refuses?"** It moves to
`rejected`, where it stops blocking the queue but stays recoverable for a human,
and the ASHA sees which field was refused. It is not silently dropped and it does
not jam sync.

---

## 7. Honesty features — say these before you're asked

These exist because a demo that looks live but isn't is how you confidently give a
judge a wrong answer.

- **The service worker never caches `/api/`** (`web/sw.js`). Staleness lives in
  `api.js`, which can say "showing data cached at 14:32".
- **A 404 is not treated as being offline** (`api.js`, `getJSON()`). Falling back
  to cache on a 404 would show a stale copy of a patient the server just said it
  doesn't have.
- **`navigator.onLine` is only a hint.** It lies on captive portals and on venue
  Wi-Fi that associates but doesn't route — so every read falls back on failure
  rather than trusting the flag. Worth saying at a venue.
- **The mic explains itself when it can't work** (`capability.js`). Offline it says
  voice needs a network; on an insecure origin it says the browser blocked it.

---

## 8. Known limits — volunteer these

Being first to name a weakness is worth more than being caught at it.

- **The cohort is synthetic**, 1,200 patients calibrated to published Indian NCD
  marginals. No real patient data is involved. Every row is flagged
  `is_synthetic`. This is also why the server binding `0.0.0.0` for the phone demo
  is acceptable — there is no real data to expose. It is unauthenticated, and a
  production deployment would need auth.
- **Voice is not on-device.** Chrome's Web Speech API streams audio to Google, so
  it cannot work in airplane mode. On-device Kannada ASR or Bhashini is the
  production path and is not shipped here. Demo the mic *before* going offline.
- **CBAC item weights need verification** against the MoHFW operational guideline
  — the ≥ 4 cut-off is stable and widely cited, but individual item point values
  vary between state versions. The code says so at the top of `cbac_score`.
- **Hypertension is weak** (AUC 0.642) and the model card states it.
- **No real-world validation.** The model is trained and evaluated on synthetic
  data; the honest claim is a working system and a defensible method, not a
  clinically validated instrument.

---

## 9. What `run_all.sh` actually proves

Eight stages, and the rule is that a build which doesn't print ALL GREEN doesn't
get demoed. Worth knowing what each one buys, because "we have tests" is a weak
answer and "stage 2 asserts prevalence gradients run the right way" is a strong
one.

| Stage | What it would catch |
|---|---|
| 1 bootstrap | a coefficient with a clinically backwards sign — aborts the build |
| 2 cohort gate | plausible headline rates but *inverted* gradients, which would train a model that explains itself backwards on stage |
| 3 fixture | regenerates the 2,100 boundary cases |
| 4 parity | `risk.js` drifting from `risk.py` |
| 5 voice | spoken-number parsing, 227 assertions |
| 6 validation | anything reaching the scorer unchecked, 4,235 assertions |
| 7 shell + CSP | a file the app boots from missing from the precache list |
| 8 end-to-end | the whole offline → queue → sync → dashboard path, 170 checks |

The last check is the one to mention if asked about test discipline: it asserts
the tests left the demo database byte-for-byte as stage 1 built it. The e2e suite
writes, including a patient whose name is deliberately markup, and those rows
score HIGH — so they used to sort *above* every real patient on the dashboard.
Stage 8 now serves a disposable copy, and the guard fails loudly if anyone
reintroduces a test that writes to demo data.

**If they push — "have your tests ever actually failed?"** Yes, and that is the
point. Deliberate bugs were injected into the parity and e2e subjects — a CBAC
boundary `<=` flipped to `<`, a removed Part B escalation, absolute waist
substituted for sex-adjusted excess, a dropped offline queue write, a diverged
client waist cut-off, a silently hidden staleness notice — and all were caught. A
suite nobody has seen fail is not evidence of anything.

---

## Traps

- Never quote **0.837**. It came from a throwaway earlier prototype and it is dead.
- Don't say the system *reduces* referral load. It reorders. See §4.
- Don't claim voice works offline. See §8.
- Don't call the cohort real. See §8.
- Don't demo a build that isn't ALL GREEN on *that laptop*. The runbook is
  explicit about this for a reason.

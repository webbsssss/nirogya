# Nirogya — Presentation Plan

**Team SANKALP · IHSIH007 · SIH Internal Hackathon**
**Friday 28 August 2026, 15:10 · 5 min presentation + 10 min Q&A · own laptop · minimum 4 members present**

---

## 0. Read this first

Nobody can guarantee you pass this round, and any plan that says otherwise is
selling you something — your own battle plan says the same thing on page one, and
it was right. What a plan *can* do is remove the things that reliably lose rounds:
running over time, a number a judge disproves, a demo that dies, and an overclaim
that unravels in follow-up. All four are addressable, and this document addresses
them.

**The one strategic thing to understand about this format.** You get 5 minutes to
present and 10 minutes of questions. Two-thirds of your time in front of these
judges is Q&A. So the presentation is a *trailer, not the film*. Its job is to
prove one thing physically — that this works with no network — and to leave
deliberate hooks that pull judges toward the questions you can answer best.

Do not try to say everything in 5 minutes. You will run over, you will be stopped
mid-sentence, and you will have spent your best material on a monologue instead of
a conversation. **Leave the model card, the parity test, the validation layer and
the referral-floor arithmetic out of the pitch.** Let them be pulled out of you.
An answer given because a judge asked for it is worth several times the same
sentence delivered unprompted.

---

## 1. Countdown

### Today (Thu 27 Aug), from now

- [ ] **Feature freeze, now.** Nothing new gets built. The repo is green and
      pushed; that is your submission.
- [ ] `./run_all.sh` on the **actual demo laptop** → ALL GREEN. Screenshot it.
- [ ] **Deck reconciliation (highest value non-demo task).** Open the deck beside
      `nirogya/README.md` and make every number agree. Specifically hunt:
      - any surviving **AUC 0.837** — delete on sight
      - **77M** diabetics → should be **101M (ICMR-INDIAB, Lancet 2023)**
      - any claim of *reducing* referral load
      - any mention of training on Pima Indians / UCI Heart
- [ ] **Drop every number you cannot source.** See §10. A judge asking "which
      study?" and getting silence costs you more than the number ever earned.
- [ ] **The KMC ask, if there is any chance of it.** Fifteen minutes with a
      clinician or public-health faculty member, two questions only: do the CBAC
      item weights match the current MoHFW NP-NCD operational guideline, and would
      a PHC medical officer find this output usable? Write down the name and
      designation. *"We checked this with Dr. ___ at KMC"* outscores any feature
      you could add tonight.

### Tonight

- [ ] **18:00–20:00 — three full timed run-throughs.** Stopwatch visible. If you
      are over 5:00, cut from the list in §3, do not talk faster.
- [ ] **20:00–22:00 — Q&A drilling.** One person plays a hostile judge with §6
      open. Rotate who answers. The goal is that nobody answers a question that
      isn't theirs, and nobody talks past two sentences.
- [ ] Phone: `#/preflight` → every row **YES**, and airplane-mode reload actually
      works, on the phone you will hold tomorrow.
- [ ] Bag packed tonight: laptop, charger, phone, **spare cable**, power bank,
      printed copies of this file and `DEMO_RUNBOOK.md`.
- [ ] **Sleep.** Q&A is where this round is decided and sleep deprivation takes
      Q&A first. This is not a platitude.

### Tomorrow morning

- [ ] **No commits. No code. At all.** A fix at 9am has killed more demos than the
      bug it was fixing.
- [ ] Re-do `chrome://inspect` port forwarding — **it does not survive unplugging
      the cable.** Then `#/preflight` on the phone again.
- [ ] `./run_all.sh` once more → ALL GREEN.
- [ ] `FALLBACK` folder on the desktop: screenshots of all five screens.
- [ ] Two more timed run-throughs. Then stop.

### 14:10 — one hour before

Run the full §1 checklist in `DEMO_RUNBOOK.md`. It is already written and it is
good; do not improvise a replacement. The items that matter most:

- [ ] Laptop hotspot ON, phone joined to **it**, not venue Wi-Fi.
- [ ] Server running on `PORT=8010`. Second terminal open, cursor on the restart
      line, untouched.
- [ ] **Load every screen once on the phone while online.** Skipping this is the
      most common way the offline demo fails.
- [ ] Test the mic once, online. Judge the room's noise floor now.
- [ ] Airplane mode ON → reload → confirm it opens → airplane mode OFF.
- [ ] Laptop: `#/dashboard` in one tab, `#/model` in another, zoom 125%.
- [ ] Phone brightness max, auto-lock never, DND on.
- [ ] Laptop plugged in. Phone above 60%.

### 15:00 — in position

Laptop open on the problem slide. Phone unlocked, in the driver's hand, app open
on the Screen tab. Nobody touching anything. Breathe.

---

## 2. The first sixty seconds in the room

**Before you speak.** Four of you stand. Speaker slightly forward, phone driver
beside them with the phone already visible in their hand. The other two stand back
— present, not crowding. Laptop faces the judges, not you.

**Open with the claim, not the courtesy.** A thirty-second "good afternoon we are
team SANKALP from MAHE and our problem statement is…" spends 10% of your time on
information the judges already have on their sheet. Compress it to one breath:

> *"Team SANKALP, problem statement IHSIH007. Karnataka's ASHA workers already run
> the government's CBAC screening on paper. We turned that same checklist into an
> offline phone app that scores diabetes risk on the device, and turns the paper
> into a district heatmap that tells the taluk health officer where to send the
> next mobile camp."*

That is roughly 20 seconds and it does three things: names the team, states the
claim, and — importantly — makes no claim you cannot defend for ten minutes. No AI
breakthrough. No reduced workload. No diagnosis.

**Then say what you are about to prove.** One sentence, because it buys the judges'
attention for the demo:

> *"The part worth watching is in the middle, when I put the phone in airplane
> mode."*

---

## 3. The 5-minute script

Cumulative clock. Owner in brackets. **Rehearse to 4:45 so 5:00 is your ceiling,
not your target.**

| Clock | Beat | Owner |
|---|---|---|
| 0:00–0:20 | Open + the claim (§2) | Speaker |
| 0:20–0:50 | The problem — one slide | Speaker |
| 0:50–1:35 | Screen a patient, live, on the phone | Driver + Speaker |
| 1:35–2:35 | **AIRPLANE MODE** | Driver + Speaker |
| 2:35–3:00 | Sync — then Sync again | Driver |
| 3:00–3:50 | District dashboard + one patient trend | Speaker |
| 3:50–4:25 | Safety architecture, spoken | Speaker |
| 4:25–4:45 | Close | Speaker |
| 4:45–5:00 | Buffer. Hand over. | — |

### 0:20–0:50 · The problem — one slide, thirty seconds

> *"An ASHA in Byndoor screens around thirty households a day on paper. That paper
> reaches the PHC weeks later, if at all. And CBAC as written refers 46% of the
> adults she sees — a PHC cannot absorb 46% of the adult population, so referrals
> get worked in whatever order the forms were stacked in."*

That last clause is the problem statement. Everything after it is the answer.

### 0:50–1:35 · Screen a patient · forty-five seconds

Phone held up so judges see the screen. Enter the known-HIGH profile: **age 58,
male, waist 97 cm, sedentary, both parents diabetic, current tobacco.**

Tap the mic on the waist field and say the number in Kannada **only if the room is
quiet enough**. If it is not: *"voice entry is here for low-literacy users — I'll
type it so you can hear me."* **Never fight a microphone on stage.**

Submit. Result appears instantly: **CBAC 8, IDRS 90, ML risk 72%, band HIGH**, with
referral reasons and the top three drivers.

> *"That scored on the phone. Nothing left the device."*

**Voice happens here and nowhere else.** Chrome streams audio to Google to
recognise it, so the mic is dead in airplane mode by design.

### 1:35–2:35 · Airplane mode · sixty seconds · DO NOT RUSH THIS

This is the single most valuable minute you have. Every team will *say*
offline-first. You are the only one who will prove it physically, on a device a
judge could hold.

1. Turn on airplane mode. **Hold the phone up so the airplane icon is visible.**
   Say: *"There is now no network on this device."*
2. Fill and submit a second screening. It scores. Point at the queue badge.
   > *"One record waiting. The scoring didn't wait for a server — the model is
   > seven coefficients running in JavaScript on this phone."*
3. **Reload the app, still in airplane mode.** Let it come back.
   > *"That's a cold start with no network. The app itself is cached, not just the
   > data."*

If `#/preflight` did **not** say Offline reload: YES in prep, do steps 1–2 only,
skip the reload, and say: *"scoring is on-device; the installable offline shell
needs https, which we'd have in production."* **Never reload on stage on a device
you have not checked.**

### 2:35–3:00 · Sync, twice · twenty-five seconds

Airplane mode off. Press **Sync** — badge clears. Then **press Sync again.**

> *"Nothing duplicated. It's idempotent, keyed on a client-generated UUID. Field
> connectivity is flaky by definition, so a retry has to be free."*

That second press is a small thing that lands hard with technical judges. Keep it.

### 3:00–3:50 · District view · fifty seconds

Switch to the laptop.

> *"Same records, rolled up. Byndoor is at 36.8% high-risk against a district
> average of 21.7% — so the recommendation is to put the next mobile camp in
> Byndoor."*

Then open patient **NRG1020**:

> *"Seven visits. Fasting glucose climbing, and the alert says +30.5 mg/dL from a
> baseline of 179.5. This is the part paper cannot do — any single reading here
> looks unremarkable. The trend does not."*

**Know your own table.** If a judge subtracts 177 from 210 and gets +33, they have
spotted something real: *"The baseline is the mean of the first two visits, not the
first reading, so one noisy visit can't invent an alert or hide one. The alert
states its baseline and the arithmetic is shown underneath."*

### 3:50–4:25 · Safety architecture · thirty-five seconds · say it, don't navigate

Do not open the model card. You do not have time, and you *want* this pulled out
of you in Q&A.

> *"One thing about how the AI sits in this. CBAC of 4 or more, any Part B red
> flag, or IDRS of 60 or more refers the patient regardless of what our model
> says. The model can only ever add a referral. It can never remove one the
> government's rules require. So the worst our model can do is over-refer — it
> cannot under-refer relative to what happens today."*

This is the strongest thirty-five seconds in your pitch. It answers "what if your
AI is wrong" before anyone asks, and it demonstrates you understand where ML
belongs in a clinical pathway.

### 4:25–4:45 · Close · twenty seconds

> *"Everything you saw runs with two commands, no internet and no installs, on a
> phone an ASHA already owns. The cohort is synthetic and labelled as such on
> every screen. The next step is a pilot against PHC-confirmed outcomes. Happy to
> take questions."*

Ending early and deliberately reads as control. Ending at 5:30 because you were
stopped reads as the opposite.

### Cut list, in order

Running long at the 3:00 mark? Cut in this order:

1. The NRG1020 trend (keep the heatmap sentence)
2. The problem slide → fold into the opening sentence
3. The second screening in airplane mode → reload only

**Never cut airplane mode. Never cut the safety architecture.**

---

## 4. How to run the 10 minutes of Q&A

Ten minutes is roughly 12 to 18 questions. It is long. It will feel long. Silence
between questions is the judges thinking, not a cue for you to keep talking.

**Answer in one or two sentences, then stop.** Over-explaining reads as
uncertainty, and every extra sentence is a new surface to attack. If they want
more they will ask.

**Route, don't crowd.** Agree the ownership map before you walk in:

| Topic | Who answers |
|---|---|
| Clinical, CBAC/IDRS, referral pathway | Speaker |
| Model, AUC, features, explainability | Build owner |
| Offline, sync, architecture, testing | Build owner |
| Demo, device, deployment reality | Driver |
| Impact, pilot, scale, integration | 4th member |

One person answering everything makes the other three look like passengers.
Judges notice. The 4th member **must** field something — give them the impact and
pilot questions, which are the easiest to prepare and the hardest to get wrong.

**The handoff phrase.** *"That's ___'s area"* — then actually stop talking. Do not
answer and then hand over.

**"I don't know" protocol.** Say: *"I don't know — I'd have to check."* Then stop.
Do not speculate to a clinician. One bluff, caught, discounts everything else you
said. A team that says "I don't know" twice in ten minutes reads as honest; a team
that bluffs once reads as unreliable.

**If a judge is wrong about something,** correct them once, politely, with the
mechanism — not the assertion. *"It actually does X, because Y — happy to show
you."* Then move on. Do not win the argument twice.

**If the demo failed,** you now have ten minutes to recover, which is plenty. Say
early: *"the demo didn't cooperate — I can show you the same thing in the code, or
answer anything you'd like."* Then be excellent at questions. Teams have passed
rounds on Q&A alone after a dead demo. They do not pass after arguing with a
laptop.

---

## 5. Hooks — questions you want, and how to invite them

You deliberately left material out. These are the lines that pull it back in.
Drop at most two, and only if the conversation stalls.

- *"…and we test that the phone and the server agree on every case."* → invites
  **the parity question**, which almost no team can answer at all.
- *"…the model card states the limitations."* → invites **AUC and honesty**, both
  of which favour you.
- *"…the server doesn't trust the app's input either."* → invites **the validation
  layer**.
- *"…the harness has eight stages and it's what decides whether we demo a build."*
  → invites **engineering discipline**.

---

## 6. Predicted questions

Marked **[VL]** very likely, **[L]** likely, **[P]** possible. Answers are the
substance to convey, not a script to memorise — say them in your own words.

### A · Data and validity

**[VL] "Is this real patient data?"**
No — synthetic, 1,200 patients calibrated to published Indian NCD prevalences, and
labelled synthetic on every screen. We preferred that to borrowing a dataset whose
provenance we couldn't explain.

**[VL] "So what is the model actually trained on?"**
Two published India-validated instruments form the floor — CBAC and IDRS. The ML
layer re-weights the exact same CBAC field set, fitted on the synthetic cohort. No
extra fields, nothing the ASHA doesn't already collect.

**[VL] "AUC 0.713 isn't very good."**
It's what a seven-field checklist supports, and it's in line with published IDRS
and CBAC validation. If we showed you 0.95 from six questions you should assume
leakage and go looking for it. The operating point matters more here anyway — at
80% sensitivity we hold 46% specificity, PPV 0.205.

**[L] "Why tune for sensitivity?"**
Because the costs are asymmetric. A false positive costs a bus fare to the PHC. A
false negative costs a limb, or an eye.

**[P] "How do you know there's no leakage?"**
The feature space is exactly the CBAC questionnaire — seven fields, all collected
before any outcome is known. There is no lab value or diagnosis in the inputs.
And `bootstrap.py` aborts the build if any coefficient comes out clinically
backwards, which is how we caught three real bugs.

**[P] "Why the 85th percentile for the HIGH band?"**
Capacity, not statistics. It's a priority slice sized to what a PHC can actually
work. It ships as an absolute probability baked into the weights, so the phone can
band a patient offline without knowing anything about the population.

**[VL] "Have you validated against real outcomes?"**
No. That is the honest limit of this prototype and the first thing a pilot would
do. What we have is a working system and a defensible method, not a clinically
validated instrument.

### B · Clinical safety

**[VL] "What if the model is wrong about someone?"**
The government rules still refer them. The model sits strictly on top of CBAC and
IDRS and can only add referrals — a false negative from our model cannot un-refer
a patient CBAC flagged.

**[L] "Who is liable for a missed case?"**
The clinical decision stays with the PHC medical officer; this is a triage and
prioritisation aid, not a diagnostic device, and it never withholds a referral the
guidelines require. Formal regulatory positioning is beyond this prototype.

**[L] "Do your CBAC item weights match the current MoHFW guideline?"**
The ≥4 referral cut-off is stable and widely cited. Individual item point values
vary between state versions, and verifying ours against the current NP-NCD
operational guideline is an open item we've flagged in the code itself.
*(If you got the KMC review: lead with that name instead.)*

**[L] "Why is the hypertension model so much worse?"**
Because it should be — 0.642. Hypertension is largely asymptomatic and poorly
predicted by lifestyle questions; you need a cuff, not a questionnaire. We show
the number rather than hiding the model, because the honest conclusion is *measure
BP, don't predict it*, and the app prompts exactly that.

**[P] "Would a PHC medical officer actually use this?"**
The output is the CBAC form they already receive, plus an ordering and the reasons
for it. That's the design intent; confirming it with a practising MO is on our
list. *(Or cite KMC.)*

### C · Model and explainability

**[VL] "Why logistic regression and not deep learning or XGBoost?"**
Two reasons. It ports to plain JavaScript, so it runs on the phone with no
network. And the per-feature contribution is an *exact* decomposition of the
logit — not an approximation like SHAP on a tree. When the app says "waist 7 cm
above the cut-off increases risk", that's the actual arithmetic, and it sums.
Heavy models belong server-side on sync; that's the two-tier design.

**[L] "How is it explainable?"**
Every screening shows the top three drivers with the patient's own values and a
signed contribution bar. Exact, not estimated — see above.

**[L] "How do you know the phone's score matches the server's?"**
We test it. 2,100 boundary cases — every CBAC and IDRS threshold, both sexes, both
sides of every cut-off — comparing the JavaScript against the Python field by
field, including the exact reason strings. And we mutation-tested the test itself
with deliberately injected bugs, to confirm it fails when it should. Runs in under
a minute if you'd like to see it.

**[P] "What about model drift / retraining?"**
Retraining is a server-side job that emits a new ~4 KB weights file; phones pick
it up on next sync. Nothing about the deterministic floor changes, which is what
keeps the safety property stable across retrains.

**[P] "Why sex-adjusted waist rather than absolute waist?"**
Men's baseline waist is higher and sex is already a feature, so with absolute
waist the coefficient flips negative to compensate — and the explainability panel
then tells you a bigger waist *reduces* risk. Sex-adjusted excess is clinically
correct and numerically stable. The build aborts if that regresses.

### D · Engineering

**[VL] "Is the AI really running offline, or is that a cached result?"**
Airplane mode, right now, with any profile you choose. The scoring file is 236
lines of JavaScript and the model is seven coefficients.

**[L] "Does the voice input work offline too?"**
No, and we're explicit about it — Chrome streams audio to Google for recognition.
On-device or Bhashini-based Kannada ASR is the production path and isn't shipped
here. The mic tells the user that rather than failing silently.

**[L] "What happens if two ASHAs screen the same patient, or a sync half-fails?"**
Every record carries a client-generated UUID with a uniqueness constraint, so
re-sync is a no-op. And each item in a batch is isolated — one malformed record
fails itself and reports which field, instead of taking down the whole upload.
That was a real bug we found and fixed, not a hypothetical.

**[L] "Security? DPDP compliance? Consent?"**
Consent-first is a design commitment in our pitch and it is **not** implemented in
this prototype — no auth, no encryption at rest, no consent flow. The demo server
is unauthenticated on purpose so a judge's phone can load it, and the data is
entirely synthetic. Claiming shipped privacy controls you could check in the code
would be far worse than saying this plainly.

**[P] "What if the phone is lost or stolen?"**
Real deployment needs device encryption, auth and remote wipe — none of which is
in this prototype. Queued records are the exposure, and they're minutes to hours
of data, not months.

**[P] "What's the stack? Why no framework?"**
Zero dependencies — Python standard library on the server, no framework on the
client. It installs from a URL with no build step, which is the point: nothing to
break in the field, and it runs on a phone from a URL.

**[P] "How do you know the code works?"**
An eight-stage harness we run before every demo — Python/JS parity, voice parsing,
server-side validation, precache and CSP conformance, and a full
offline-capture-to-sync-to-dashboard run. Roughly 4,650 lines of app code against
2,160 lines of tests. A build that isn't green doesn't get demoed.

### E · Deployment and scale

**[VL] "Do ASHA workers actually have smartphones?"**
Smartphone penetration among ASHAs is the deployment assumption we'd test first in
a pilot, and it's the reason the app is a PWA with no install and no app store —
it runs from a URL on whatever Android they have, and it works offline because
rural connectivity can't be assumed. *If you have a sourced penetration figure,
use it. If not, do not invent one.*

**[L] "How much training would an ASHA need?"**
The form is the CBAC form she already fills, in the same order. That was a
deliberate constraint — we didn't add fields. Voice entry exists for
low-literacy users.

**[L] "How does this integrate with ABHA / eSanjeevani / the NCD portal?"**
As adapters at the sync boundary, not replacements. The records are already
structured per CBAC, which is what those systems expect. We've scoped them as
integration points; they aren't built.

**[P] "What would it cost to deploy?"**
No per-seat licence, no app store, no cloud dependency for the field tier — the
server is a single Python process. Real costs are training, supervision and
integration, not software. We haven't costed a district and won't guess at one.

**[P] "Who owns the data?"**
The health department. The architecture keeps it that way — self-hosted, no
third-party calls from the app.

### F · Impact

**[L] "What would you measure to know this worked?"**
Three things in a pilot: whether high-band referrals show higher PHC-confirmed
diagnosis rates than the rest of the referral floor, referral follow-through rate
against the paper baseline, and time from screening to record reaching the PHC.
The first one is the real test of whether the ordering has any value.

**[P] "Why should the government fund this over what exists?"**
Existing NCD systems are online-first and record-keeping-first. This is
offline-first and triage-first, built on the checklist ASHAs already fill. The
district heatmap is the part that doesn't exist today — it turns screening into a
camp-siting decision.

### G · Team and process

**[P] "Who built what?"**
Answer honestly and specifically, by name and area. Vagueness here reads badly.

**[P] "What would you do with three more months?"**
Pilot against PHC-confirmed outcomes; on-device Kannada ASR so voice survives
offline; auth, encryption and a consent flow; ABHA integration. In that order,
because the first one determines whether the rest is worth building.

### H · Traps

**"You claim offline, but your app says offline reload is disabled."**
Two different things. Scoring is on-device and always works with no network —
that's the AI claim, and you watched it. Reopening from a cold start needs a
service worker, and browsers only allow those over https; we're on plain http on a
hotspot for this demo, so the browser blocks it and we chose to say so on screen
rather than appear to work. This is a good answer — a system that surfaces its own
degraded state is one a clinician can trust.

**"Your deck says 77 million, you just said 101 million."**
101 million, ICMR-INDIAB in the Lancet, 2023 — the 77 million figure is the older
IDF-era estimate. *(Which is why the deck must be fixed today.)*

**"This is just a form with a score on it."**
The form is deliberate — it's the CBAC form, unchanged, because adoption dies when
you ask an ASHA to learn a new one. What's not just a form: it scores with no
network, it's idempotent under flaky connectivity, it explains each score exactly,
it can't override a government referral rule, and it aggregates to a camp-siting
decision. Happy to show any of those.

**"Show me the code."**
Open it. The repo is on the laptop and the harness runs in under a minute. Do not
be precious about this — it's your strongest ground.

---

## 7. Numbers cheat card

Everyone memorises these. A hesitation on your own headline number is expensive.

| | |
|---|---|
| Diabetes AUC | **0.713** (prevalence 14.5%) |
| Operating point | threshold 0.10 → **80% sensitivity**, 46% specificity, PPV 0.205 |
| Hypertension AUC | 0.642 — deliberately weak, and we say so |
| HIGH band cut-off | diabetes probability ≥ **0.2342** (85th percentile) |
| Cohort | **1,200 patients / 1,218 screenings / 8 Udupi villages** |
| CBAC ≥ 4 refers | **46.0%** of everyone screened |
| Nirogya HIGH band | **21.7%** |
| Hotspot village | **Byndoor, 36.8%** high-risk vs 21.7% district average |
| Trend patient | **NRG1020** — 7 visits, +30.5 mg/dL, baseline 179.5 |
| Demo HIGH profile | 58, male, waist 97, sedentary, both parents diabetic, current tobacco → CBAC 8, IDRS 90 |
| Model size | 7 coefficients; `risk.js` is 236 lines |
| Tests | 2,100 parity cases · 170 e2e checks · 4,235 validation assertions |
| India diabetes burden | **101 million (ICMR-INDIAB, Lancet 2023)** |

---

## 8. Forbidden phrases

Say any of these and you hand a judge a thread to pull.

- ❌ **"AUC 0.837"** — dead. From a throwaway prototype.
- ❌ **"reduces referral load"** — it reorders. It cannot reduce. §6-A.
- ❌ **"77 million"** — use 101 million.
- ❌ **"real patient data"** / any phrasing that implies it.
- ❌ **"it diagnoses"** — it screens and prioritises.
- ❌ **"voice works offline"** — it does not.
- ❌ **"trained on Pima Indians / UCI Heart"** — it is not.
- ❌ **"fully DPDP compliant"** — it is not implemented.
- ❌ **"99% accurate"** or any unsourced accuracy claim.

---

## 9. Roles for four people

Minimum four must attend. If more come, the extras stand back and stay silent —
a crowd around a laptop reads as disorganised.

**1 · Speaker.** Owns §2, §3 narration, and all clinical/pathway questions. Does
not touch a device during the five minutes.

**2 · Driver.** Owns the phone, the hotspot, the port forwarding, the `FALLBACK`
folder, and the 14:10 checklist. Owns device and deployment-reality questions.
Speaks only during the demo beats.

**3 · Build owner.** Owns model, architecture, testing and code questions. Has the
laptop ready to open the repo or run the harness if asked. Sole person who touches
the code — and nobody touches it tomorrow.

**4 · Impact.** Owns pilot design, measurement, integration, scale and cost
questions. **Must field at least two questions.** This is the easiest set to
prepare and the most damaging to fumble, because it's where a judge tests whether
you've thought past the demo.

Agree now who says the *last* sentence of the Q&A. Ending cleanly matters:
*"Thank you — the repo and the runbook are with the submission if you'd like to
look further."*

---

## 10. Unverified — drop or source before tomorrow

Your own battle plan flagged these and they are still open. **Any number you
cannot attribute to an author or journal should not leave your mouth.** One
disproved figure taints every other number you gave.

- [ ] The ~23% Gujarat referral follow-through figure — source?
- [ ] The 45.5% West Bengal retention figure — source?
- [ ] The Mysuru CBAC validation study — source?
- [ ] CBAC per-item point values vs the current MoHFW NP-NCD guideline
- [ ] Any ASHA smartphone-penetration figure you plan to quote
- [ ] Every remaining number in the deck, against `nirogya/README.md`

If you cannot source one by tonight, the move is to cut it, not to soften it.
*"Referral follow-through is poor and that's the gap we target"* is defensible.
*"Referral follow-through is 23%"* without a citation is a question you will lose.

---

## 11. If it all goes wrong

Full drills are in `DEMO_RUNBOOK.md` §5 — rehearse them once tonight. The short
version, in order of what to reach for:

1. **Phone won't connect** → laptop Chrome DevTools → Network → **Offline**. Real
   secure context, always works. *"I'll show this on the laptop."*
2. **Amber banner / reload fails** → capture-only version of the airplane beat.
   Do not debug on stage.
3. **Mic does nothing** → *"I'll type it."* Move on. Never fight it.
4. **Server dies** → second terminal, already open, one line, two seconds.
5. **Dashboard shows zeroes** → `bootstrap.py`, twenty seconds.
6. **Everything is broken** → `FALLBACK` screenshots, narrated in the same order.
   Then lean on the ten minutes of Q&A, which is where this round is actually
   decided.

A confident walkthrough of screenshots beats a panicked debugging session by a
very wide margin. You will probably not need this. Having it is why you will stay
calm — and staying calm is worth more marks than any single feature.

Good luck. The work is done and it is genuinely good. Tomorrow is only about
showing it clearly and answering honestly.

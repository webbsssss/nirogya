# Nirogya — Demo Day Runbook

Team SANKALP · IHSIH007 · MAHE Internal Hackathon, 28–29 Aug 2026

Print this. One copy for the person driving, one for the person speaking. Everything below assumes `./run_all.sh` printed **ALL GREEN** on the machine you are actually demoing from — not on someone else's laptop.

---

## 1. Ninety minutes before

Do these in order. Tick them off out loud; silent checklists get skipped.

- [ ] `cd nirogya && ./run_all.sh` → **ALL GREEN**. If not, you demo the last green commit, not this one.
- [ ] `python3 server/bootstrap.py` then `PORT=8010 python3 server/app.py`. Leave it running. Do not touch that terminal again.
- [ ] Laptop hotspot ON, phone joined to it. **Do not rely on venue Wi-Fi.** It will be saturated and it may block device-to-device traffic, which kills the phone demo specifically.
- [ ] **Set up the secure context on the phone — the offline demo is impossible without it.** Phone connected by USB with USB debugging on; laptop Chrome → `chrome://inspect` → *Port forwarding* → enable, map `8010` → `localhost:8010`. Then on the **phone** open `http://localhost:8010`. (Full instructions, plus the no-cable fallback, in README → "Running it on the demo phone".)
- [ ] On the phone, go to **`#/preflight`** and confirm **Offline reload: YES** and **Voice input: YES**. If offline reload says NO, stop and fix the secure context — do not proceed and hope. This screen exists because the app looks fine right up until airplane mode.
- [ ] On the phone: menu → **Add to Home screen**. Launch from the home-screen icon, not the browser tab. Standalone mode is half the "this is a real app" impression. (This also only works from a secure context.)
- [ ] Load every screen once on the phone while online: Screen → Queue → Patient NRG1020 → District → Model. This warms the service worker cache. **Skipping this is the single most common way the offline demo fails.**
- [ ] Test the **mic once, while online** — it needs the network (Chrome sends the audio to Google), so it can never work in airplane mode. Know now whether the hall's noise floor makes it usable.
- [ ] Airplane mode ON → reload the app → confirm it still opens and the roster still lists patients. Then open `#/preflight` again and confirm no amber banner appeared. Airplane mode OFF.
- [ ] Laptop browser: open `#/dashboard` in one tab and `#/model` in another. Zoom to 125%. Judges are standing and reading over your shoulder.
- [ ] Phone brightness to max, auto-lock to "never" or 5 minutes. Do-not-disturb ON.
- [ ] Battery: laptop plugged in, phone above 60%.
- [ ] Screenshots of all five demo screens (Screen, Queue, Patient, District, Model) saved to the laptop desktop, in a folder called `FALLBACK`. Insurance, see §5.

**If an amber banner is showing anywhere in the app, the offline demo will not work.** The banner names the reason and links to `#/preflight`. Read it rather than reloading and hoping.

**Two people own the demo.** One drives the phone, one speaks. They are not the same person. Nobody else touches a device during the four minutes.

---

## 2. The one-sentence answer

Before anything else, everyone on the team should be able to say this without thinking:

> *"Karnataka's ASHA workers already run the government's CBAC screening on paper. Nirogya turns that same checklist into an offline phone app that scores diabetes risk on the device, and turns the paper into a district heatmap that tells the taluk health officer which village to send the next mobile camp to."*

Note what that sentence does **not** claim: no AI breakthrough, no reduced workload, no diagnosis. It claims a workflow that exists on paper now works offline and produces district-level intelligence. That is defensible for the full duration of the Q&A, which is the entire point.

---

## 3. The four-minute demo

Timings are targets. If you're running long, cut beat 5, never beat 3.

**Beat 1 — the problem, 30 seconds.** *"An ASHA worker in Byndoor screens 30 households a day. She fills CBAC forms on paper. That paper reaches the PHC weeks later, if it reaches it. Meanwhile CBAC refers 46% of the adults she sees, and the PHC can see a fraction of that — so referrals get worked in the order the forms happened to be stacked."* Do not open a slide. Say it.

**Beat 2 — screening, 45 seconds.** Phone in hand, visible. Fill the form with the known-HIGH profile: **age 58, male, waist 97 cm, sedentary, both parents diabetic, current tobacco user.** Tap the mic on the waist field and say the number in Kannada if the ambient noise allows — if it doesn't, say *"voice entry is here for low-literacy users; I'll type it so you can hear me"* and move on. **Never fight a mic on stage.**

> **Voice happens here, while you are still online, and nowhere else.** Chrome streams the audio to Google to recognise it, so the mic is dead in airplane mode by design. If a judge asks for voice during beat 3, say: *"Speech recognition is a cloud call in Chrome — on-device Kannada ASR is the production path and we haven't shipped it. The scoring is what runs offline."* That is a better answer than a mic that does nothing.

Submit. The result appears instantly: **CBAC 8, IDRS 90, ML risk 72%, band HIGH**, with the referral reasons and the top three drivers listed.

**Beat 3 — the moment that wins it, 45 seconds. Do not rush this.**

Turn on airplane mode. Hold the phone up so the airplane icon is visible. Say: *"There is now no network on this device."* Fill and submit a second screening. It scores. Point at the queue badge: *"That's one record waiting. The scoring didn't wait for a server, because the model is running in JavaScript on this phone."*

Then reload the app with airplane mode still on, and let it come back. That second half is the part that needs the service worker — and the part that needs `#/preflight` to have said **Offline reload: YES** in the prep window. If for any reason it didn't, do the capture half only, skip the reload, and say *"scoring is on-device; the installable offline shell needs https, which we'd have in production"*. Never reload on stage on a device you haven't checked.

Turn airplane mode off. Press **Sync**. The badge clears. Then — and this is the detail that lands with technical judges — **press Sync a second time.** Nothing duplicates. Say: *"Idempotent, keyed on a client-generated UUID. Field connectivity is flaky by definition, so a retry has to be free."*

**Beat 4 — the district view, 60 seconds.** Switch to the laptop dashboard. Point at the heatmap. *"Same data, rolled up. Byndoor is at 36.8% high-risk against a district average of 21.7%. The system's recommendation is to put the next mobile camp in Byndoor."* Then open patient **NRG1020**: seven visits, fasting glucose rising, the alert reading *"Fasting blood sugar +30.5 mg/dL (baseline 179.5, mean of first 2 visits → 210 latest, across 7 visits). Escalate to PHC."* Say: *"This is the part paper cannot do. A single reading is normal-ish; the trend is not."*

If a judge subtracts from the visit table and gets +33 instead of +30.5, they have spotted something real and you have the answer: *"The baseline is the mean of the first two visits, not the first reading, so one noisy visit can't invent an alert or hide one. The alert states its baseline and the line underneath shows the arithmetic."* Don't be caught out by your own table — that's the difference between looking rigorous and looking sloppy.

**Beat 5 — the model card, 45 seconds.** Open `#/model`. *"AUC 0.713 on the diabetes model. We'd rather show you that than a 0.95 you'd be right to distrust from a seven-field checklist. At an 80%-sensitivity operating point we hold 46% specificity."* Then the safety architecture, which is the strongest thing you have: *"CBAC ≥ 4, any Part B red flag, or IDRS ≥ 60 refers the patient regardless of what our model says. The model can only ever add a referral. It cannot remove one the government's rules require."*

**Close, 15 seconds.** *"Everything you just saw runs with two commands, no internet, and no installs, on a phone an ASHA worker already owns. The cohort is synthetic and labelled as such — the next step is a pilot against PHC-confirmed outcomes at KMC."*

---

## 4. Q&A — the ten questions you will get

Answer in one or two sentences, then stop. Over-explaining reads as uncertainty.

**"Is this real data?"**
No — synthetic, calibrated to published Indian NCD prevalences, and labelled as synthetic on every screen. We chose that over borrowing a dataset we couldn't explain the provenance of.

**"So you reduce the referral burden?"**
No, and we're careful about this. The deterministic rules only escalate, so we cannot shrink the 46% CBAC floor — that floor is the government's. What we add is an *ordering inside* it, so the top 22% gets worked first instead of the stack getting worked in arrival order. **Do not let anyone on the team accidentally claim reduction. It's the one overclaim that would be easy to disprove on the spot.**

**"AUC 0.713 isn't very good."**
It's what a seven-question checklist supports, and it's consistent with published IDRS and CBAC validation. We'd be more worried if it were 0.9. And the operating point matters more than the AUC here — at 80% sensitivity we're catching four in five cases, which is what a screening tool is for.

**"Why is the hypertension model worse?"**
Because it should be. 0.642. Hypertension is largely asymptomatic and poorly predicted by the lifestyle fields CBAC collects — you need a cuff, not a questionnaire. We show the number rather than dropping the model, because the honest conclusion is *measure BP, don't predict it*, and the app prompts exactly that.

**"What if the model is wrong about someone?"**
Then the government rules still refer them. The model sits strictly on top of CBAC and IDRS and can only add referrals. A false negative from our model cannot un-refer a patient CBAC flagged.

**"Is the AI really running offline, or is that a cached result?"**
Airplane mode, again, right now, with a profile you choose. The scoring code is 200 lines of JavaScript and the model is seven coefficients. There's also a test in the repo that checks the phone's score matches the server's on 2,100 boundary cases.

**"Your app told me offline reload was disabled — so is it offline or not?"** (You'll get this if the banner is up.)
Two different things. Scoring is on-device and works with no network, always — that's the AI claim and you just watched it. Reopening the app from a cold start with no network needs a service worker, and browsers only allow those over https. We're serving over plain http on a hotspot for this demo, so the browser blocks it and we chose to say so on screen instead of quietly appearing to work. In deployment it's https and the app installs. **This is a good answer, not an embarrassing one — a team that surfaces its own degraded state is a team a clinician can trust.**

**"Does the voice input work offline too?"**
No, and we're explicit about it: Chrome streams audio to Google for recognition. On-device or Bhashini-based Kannada ASR is the production path and isn't shipped here. The mic tells the user that rather than failing silently.

**"How is this different from existing NCD apps / eSanjeevani / NCD portal?"**
Those are online-first and record-keeping-first. Nirogya is offline-first and triage-first, and it's built on the checklist ASHAs already fill rather than asking them to learn a new form. We've written the ABHA and eSanjeevani adapters as integration points, not replacements.

**"Privacy? DPDP?"**
Consent-first is a design commitment in our pitch, and it is **not** implemented in this prototype — no auth, no encryption at rest, no consent flow. Say that plainly. Claiming shipped privacy controls that a judge could check in the code is a much worse outcome than admitting scope.

If you don't know an answer: *"I don't know — I'd have to check."* Then move. Bluffing to a clinician judge is unrecoverable.

---

## 5. Failure drills

Rehearse each of these once. Ninety seconds each. The goal is that nobody freezes.

**The phone won't connect to the laptop.** Switch to the laptop browser and use Chrome DevTools → Network → **Offline** for the airplane-mode beat. Say *"I'll show this on the laptop"* and continue. Do not spend stage time on Wi-Fi settings.

**The amber banner is showing / airplane-mode reload gives a browser error page.** The phone is on an insecure origin, so the service worker never registered. This is a five-minute fix in prep and a zero-minute fix on stage — so on stage, do not attempt it. Do the capture-only version of beat 3 (score offline, show the queue, sync) and move on. In prep: `chrome://inspect` port forwarding, load `http://localhost:8010` on the phone, confirm `#/preflight` says Offline reload YES. Fallback is the laptop with DevTools → Offline, which is a real secure context and always works.

**The mic does nothing.** If you are offline, that is expected — Chrome's speech recognition is a cloud call. If you are online and it still does nothing, the origin is insecure (same cause as above) and the app will say so when you tap it. Either way: *"I'll type it"*, and keep going. Voice is a supporting feature; the offline scoring is the claim.

**The app loads blank on the phone.** Uninstall the home-screen icon, reopen the plain URL in Chrome. If still blank, laptop browser. Cause is nearly always a stale service worker — which is why §1 has you load every screen while online.

**The server dies.** Second terminal, already open, cursor already on the line: `python3 server/app.py`. It restarts in two seconds and the DB is untouched. Have this terminal open before you start.

**The database looks empty / dashboard shows zeroes.** `python3 server/bootstrap.py` rebuilds in about twenty seconds. `app.py` refuses to start on an empty DB specifically so you find this out in the prep window rather than in front of judges.

**Voice recognition produces garbage.** Expected in a loud hall. *"It's noisy in here — I'll type it."* The mic never auto-commits a value, so a bad transcription cannot corrupt a record. Say that; it's a design point in your favour.

**Everything is broken.** The `FALLBACK` screenshot folder, narrated in the same order as §3. A confident walkthrough of screenshots beats a panicked debugging session by a wide margin. You will not need this. Having it is why you'll stay calm.

---

## 6. Division of labour, 26–27 Aug

Six people, and the failure mode is all six editing code. Only two should be.

**Person 1 — Build owner.** Sole owner of `risk.py` / `risk.js`. Runs `run_all.sh` before every push. Nobody else commits to `server/` or `web/js/`.

**Person 2 — Demo driver.** Owns the phone, the hotspot, the install, the `FALLBACK` folder, and §1. **Also owns the secure context**: gets `chrome://inspect` port forwarding working on the actual demo phone and `#/preflight` reading all-YES, at least a day early, and knows how to redo it in five minutes if the phone is reset. Rehearses beats 2–4 until muscle memory. Does not write code.

**Person 3 — Speaker.** Owns §2, §3 narration and §4. Rehearses the ten answers out loud with someone playing a hostile judge. Does not write code.

**Person 4 — Validation.** The highest-leverage non-coding job: get **fifteen minutes with a clinician or public-health faculty member at KMC** and ask exactly two things — do the CBAC item weights match the current MoHFW NP-NCD operational guideline, and would a PHC medical officer find the referral output usable. Write the answer down, with the name and designation. "We checked this with Dr. ___ at KMC" is worth more in Q&A than any feature you could add in a day.

**Person 5 — Deck and continuity.** Reconciles the submitted PPT against the numbers in `nirogya/README.md`. **Any number in the deck that disagrees with the app is a live hazard** — a judge with the deck open while you present will spot it. In particular hunt down every trace of the dead **AUC 0.837**.

**Person 6 — Adversary.** Spends Wednesday trying to break the demo: submit blank fields, age 0, age 120, negative waist, submit twice fast, kill Wi-Fi mid-sync, hard-reload during a sync, open two tabs and sync both. Files each break. This role finds more than the two builders will.

---

## 7. The night before

- [ ] `./run_all.sh` on the actual demo laptop → ALL GREEN. Screenshot the green output; it's your evidence if something changes overnight.
- [ ] On the demo phone: `#/preflight` → every row YES, **and** airplane-mode reload works. Do this on the phone you will actually hold, tonight. Port forwarding does not survive unplugging the cable, so re-check it in the morning too.
- [ ] Freeze the code. **No commits on demo day.** A fix at 8am on demo day has broken more hackathon demos than any bug it was fixing.
- [ ] Full run-through, end to end, twice, with a phone and a laptop, timed. Under four minutes.
- [ ] One person does §5 drills while another narrates, so both failure paths are in muscle memory.
- [ ] Chargers, a spare cable, and a power bank in the bag tonight, not tomorrow morning.
- [ ] Everyone sleeps. A team that has rehearsed and slept out-presents a team that built one more feature at 3am. This is not a platitude — the Q&A is where this is won, and Q&A is the first thing sleep deprivation takes.

"""
Server-side input validation tests.

  python3 tests/validate_test.py

WHY THIS EXISTS. The screening form enforces every range in validate.py already,
which is exactly why the server did not: the checks looked redundant. They are not.
The form is a usability feature; the server is the boundary. Anything posted
straight to /api/screen skipped the form entirely, and three things happened:

    {"age": "fifty"}        TypeError  -> HTTP 500 + a leaked Python traceback
    {"tobacco": "vape"}     KeyError   -> HTTP 500 + a leaked Python traceback
    {"age": -5, "waist_cm": 0}         -> scored, STORED, and nobody told

The last one is the reason for the fuzz section at the bottom. A 500 is loud and
gets fixed. A minus-five-year-old with a zero-centimetre waist sitting in a
clinical table is silent, and it is the kind of thing a judge finds by typing a
number into a URL.

THE THEOREM, and the assertion that matters most in this file:

    for every payload:  clean_screening() raises Invalid
                        OR risk.assess(cleaned) completes without raising

That is the whole claim "nothing reaches the scorer unvalidated", stated as
something a machine can check. Section 9 checks it against several thousand
deliberately hostile payloads.
"""

import json
import math
import random
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import risk           # noqa: E402
import validate       # noqa: E402
from validate import Invalid, clean_screening, clean_limit, clean_query  # noqa: E402

failures = []
groups = {}


def check(group, label, got, want):
    groups[group] = groups.get(group, 0) + 1
    if got != want or type(got) is not type(want):
        failures.append((group, label, got, want))
        if len(failures) <= 25:
            sys.stderr.write(f"\n  FAIL [{group}] {label}\n"
                             f"    got  {got!r} ({type(got).__name__})\n"
                             f"    want {want!r} ({type(want).__name__})\n")


def rejects(group, label, payload, field=None):
    """The payload must be refused, and the message must NAME the bad field.

    Both halves matter. A rejection that does not say which field was wrong is
    unactionable for an ASHA re-entering the record, and unactionable for us on
    stage.
    """
    groups[group] = groups.get(group, 0) + 1
    try:
        clean_screening(payload)
    except Invalid as e:
        named = [f["field"] for f in e.fields]
        if field and field not in named:
            failures.append((group, f"{label} (blamed {named}, expected {field})", named, field))
            sys.stderr.write(f"\n  FAIL [{group}] {label}: blamed {named}, expected {field!r}\n")
        elif any(not f.get("message") for f in e.fields):
            failures.append((group, f"{label} (empty message)", e.fields, "a message"))
        return
    failures.append((group, label, "ACCEPTED", "Invalid"))
    sys.stderr.write(f"\n  FAIL [{group}] {label}: was ACCEPTED, expected rejection\n")


def accepts(group, label, payload):
    groups[group] = groups.get(group, 0) + 1
    try:
        return clean_screening(payload)
    except Invalid as e:
        failures.append((group, label, str(e), "accepted"))
        sys.stderr.write(f"\n  FAIL [{group}] {label}: REJECTED — {e}\n")
        return None


def base(**over):
    """A valid screening. Exactly what web/js/app.js toPatient() produces."""
    p = {
        "name": "Test Patient", "sex": "F", "age": 52, "village": "Byndoor",
        "waist_cm": 88.5, "activity_level": "sedentary", "active_minutes_week": 20,
        "parents_with_diabetes": 1, "family_history": True,
        "tobacco": "never", "alcohol": False,
        "sbp": 138, "dbp": 88, "fbs": 132,
        "persistent_cough_2wk": False, "shortness_of_breath": False,
        "unexplained_weight_loss": False, "lump_or_sore_not_healing": False,
        "difficulty_opening_mouth": False,
        "client_uuid": "11111111-2222-3333-4444-555555555555",
        "screened_on": "2026-08-20",
    }
    p.update(over)
    return p


# ---------------------------------------------------------------------------
# 1. The happy path, and normalisation
# ---------------------------------------------------------------------------
c = accepts("happy path", "a form-shaped payload", base())
if c:
    check("happy path", "age stays an int", c["age"], 52)
    check("happy path", "waist keeps its half centimetre", c["waist_cm"], 88.5)
    check("happy path", "sex", c["sex"], "F")
    check("happy path", "screened_on", c["screened_on"], "2026-08-20")
    check("happy path", "name", c["name"], "Test Patient")

check("normalise", "sex is upper-cased", accepts("normalise", "lowercase sex", base(sex="f"))["sex"], "F")
check("normalise", "tobacco is lower-cased", accepts("normalise", "CURRENT", base(tobacco="CURRENT"))["tobacco"], "current")
check("normalise", "numeric string age coerces", accepts("normalise", 'age "52"', base(age="52"))["age"], 52)
check("normalise", "numeric string waist coerces", accepts("normalise", 'waist "88.5"', base(waist_cm="88.5"))["waist_cm"], 88.5)
check("normalise", "45.0 is a whole number", accepts("normalise", "age 45.0", base(age=45.0))["age"], 45)
check("normalise", "blank name becomes Unnamed", accepts("normalise", "name ''", base(name=""))["name"], "Unnamed")
check("normalise", "blank village becomes Unknown", accepts("normalise", "village ''", base(village=""))["village"], "Unknown")
check("normalise", "control characters are stripped",
      accepts("normalise", "name with newline", base(name="Sunita\nDevi\x00"))["name"], "SunitaDevi")

# ---------------------------------------------------------------------------
# 2. Required fields
# ---------------------------------------------------------------------------
for f in ("age", "sex", "waist_cm", "tobacco", "active_minutes_week"):
    rejects("required", f"{f} missing", {k: v for k, v in base().items() if k != f}, f)
    rejects("required", f"{f} None", base(**{f: None}), f)
    rejects("required", f"{f} empty string", base(**{f: ""}), f)

# Every problem at once, not just the first — an ASHA must not have to rediscover
# them one submit at a time.
groups["required"] = groups.get("required", 0) + 1
try:
    clean_screening({"age": "x", "sex": "Q", "waist_cm": None, "tobacco": "vape",
                     "active_minutes_week": -1})
    failures.append(("required", "five bad fields", "ACCEPTED", "Invalid"))
except Invalid as e:
    named = sorted(f["field"] for f in e.fields)
    want = ["active_minutes_week", "age", "sex", "tobacco", "waist_cm"]
    if named != want:
        failures.append(("required", "reports ALL bad fields at once", named, want))
        sys.stderr.write(f"\n  FAIL [required] reports all bad fields: {named} != {want}\n")

# ---------------------------------------------------------------------------
# 3. Enums. Each of these was an uncaught KeyError inside risk.py.
# ---------------------------------------------------------------------------
for bad in ("vape", "smoker", "nevr", "", "CURRENTLY", "0"):
    rejects("enum", f"tobacco={bad!r}", base(tobacco=bad), "tobacco")
for bad in ("low", "high", "none", "MODERATE-ish", "1"):
    rejects("enum", f"activity_level={bad!r}", base(activity_level=bad), "activity_level")
for bad in ("X", "male", "MF", "1", "Other"):
    rejects("enum", f"sex={bad!r}", base(sex=bad), "sex")
# 'male'/'female' are NOT accepted on purpose: risk.py indexes WAIST_CUTOFF[sex]
# and compares sex == "F", so anything but M/F is a KeyError. Guessing at a
# spelling here would hide the mismatch instead of surfacing it.
check("enum", "activity_level defaults to moderate",
      accepts("enum", "no activity_level", {k: v for k, v in base().items() if k != "activity_level"})["activity_level"],
      "moderate")

# parents_with_diabetes indexes a dict {0,1,2} in risk.idrs_score.
for bad in (3, -1, 1.5, "two", 99):
    rejects("enum", f"parents_with_diabetes={bad!r}", base(parents_with_diabetes=bad), "parents_with_diabetes")
check("enum", 'parents "1" coerces', accepts("enum", 'parents "1"', base(parents_with_diabetes="1"))["parents_with_diabetes"], 1)
check("enum", "parents defaults to 0",
      accepts("enum", "no parents field", {k: v for k, v in base().items() if k != "parents_with_diabetes"})["parents_with_diabetes"], 0)

# ---------------------------------------------------------------------------
# 4. Types
# ---------------------------------------------------------------------------
rejects("types", 'age "fifty"', base(age="fifty"), "age")
# isinstance(True, int) is True in Python, so an unguarded numeric check reads
# `"age": true` as the age 1.
rejects("types", "age true", base(age=True), "age")
rejects("types", "age false", base(age=False), "age")
rejects("types", "age as a list", base(age=[52]), "age")
rejects("types", "age as an object", base(age={"v": 52}), "age")
rejects("types", "waist as a list", base(waist_cm=[88]), "waist_cm")
rejects("types", "sex as a number", base(sex=1), "sex")
rejects("types", "whole body is a list", ["not", "an", "object"], "_body")
rejects("types", "whole body is a string", "age=52", "_body")
rejects("types", "whole body is null", None, "_body")

# NaN and Infinity are reachable: json.loads accepts those bare literals by
# default. A NaN age makes every comparison in cbac_score false, so it scores as
# the OLDEST band, and json.dumps then writes `NaN`, which JSON.parse cannot read.
for bad in (float("nan"), float("inf"), float("-inf")):
    rejects("types", f"age {bad}", base(age=bad), "age")
    rejects("types", f"waist {bad}", base(waist_cm=bad), "waist_cm")

# ---------------------------------------------------------------------------
# 5. Clinical plausibility. These all used to score and store.
# ---------------------------------------------------------------------------
for bad in (0, -5, 121, 1000, -0.5):
    rejects("range", f"age {bad}", base(age=bad), "age")
for good in (1, 40, 120):
    check("range", f"age {good} accepted", accepts("range", f"age {good}", base(age=good))["age"], good)
for bad in (0, 39, 161, -88, 5000):
    rejects("range", f"waist {bad}", base(waist_cm=bad), "waist_cm")
for bad in (19, 601, 0, -1):
    rejects("range", f"fbs {bad}", base(fbs=bad), "fbs")
for bad in (59, 261):
    rejects("range", f"sbp {bad}", base(sbp=bad), "sbp")
for bad in (-1, 10081):
    rejects("range", f"active_minutes_week {bad}", base(active_minutes_week=bad), "active_minutes_week")
rejects("range", "age 45.5 is not a whole year", base(age=45.5), "age")
check("range", "waist 88.5 is fine (step 0.5 in the UI)",
      accepts("range", "waist 88.5", base(waist_cm=88.5))["waist_cm"], 88.5)

# The server's bounds must be the SAME numbers the form and the voice path
# enforce. If they drift, a reading the keyboard refuses gets in through the API,
# and whichever of the two is stricter starts looking broken. Reading the client
# source is crude, but it fails the moment someone edits one side and not the
# other, which is exactly when we need to hear about it.
app_js = (Path(__file__).resolve().parent.parent / "web" / "js" / "app.js").read_text(encoding="utf-8")
for field, ui in (("age", "age"), ("waist_cm", "waist"), ("fbs", "fbs")):
    lo, hi, _ = validate.BOUNDS[field]
    check("client parity", f"{field} matches VOICE_RANGE.{ui}",
          f"min: {lo}, max: {hi}" in app_js, True)
for field in ("age", "waist_cm", "sbp", "dbp", "fbs"):
    lo, hi, _ = validate.BOUNDS[field]
    check("client parity", f"{field} matches the form's min/max attributes",
          f"min: '{lo}', max: '{hi}'" in app_js, True)

# ---------------------------------------------------------------------------
# 6. Booleans and the family-history derivation
# ---------------------------------------------------------------------------
for raw, want in ((True, True), (False, False), (1, True), (0, False),
                  ("1", True), ("0", False), ("true", True), ("false", False),
                  ("yes", True), ("no", False), (None, False)):
    got = accepts("flags", f"alcohol={raw!r}", base(alcohol=raw))
    if got:
        check("flags", f"alcohol {raw!r} -> {want}", got["alcohol"], want)
for bad in (2, -1, "maybe", [], {}):
    rejects("flags", f"alcohol={bad!r}", base(alcohol=bad), "alcohol")

# family_history and parents_with_diabetes are the same CBAC fact. Disagreeing is
# not a possible clinical state, so an absent family_history is derived.
no_fh = {k: v for k, v in base().items() if k != "family_history"}
check("flags", "family_history derives from 1 parent", accepts("flags", "derive fh", dict(no_fh, parents_with_diabetes=1))["family_history"], True)
check("flags", "family_history derives from 0 parents", accepts("flags", "derive fh 0", dict(no_fh, parents_with_diabetes=0))["family_history"], False)

for k in validate.PART_B:
    check("flags", f"{k} defaults False",
          accepts("flags", f"no {k}", {x: v for x, v in base().items() if x != k})[k], False)
    check("flags", f"{k} passes through",
          accepts("flags", f"{k} true", base(**{k: True}))[k], True)

# ---------------------------------------------------------------------------
# 7. Identifiers, text, dates
# ---------------------------------------------------------------------------
rejects("text", "name over the length cap", base(name="x" * 200), "name")
rejects("text", "village over the length cap", base(village="v" * 200), "village")
check("text", "a Kannada name survives intact",
      accepts("text", "Kannada name", base(name="ಸುನೀತಾ ದೇವಿ"))["name"], "ಸುನೀತಾ ದೇವಿ")
# Markup is inert in this app — h() builds text nodes and there is no innerHTML
# sink — so this asserts it passes through UNCHANGED rather than being mangled by
# some half-escaping. Sanitising here would only give a false sense of where the
# defence lives.
check("text", "markup is stored verbatim, not half-escaped",
      accepts("text", "script tag in a name", base(name="<script>alert(1)</script>"))["name"],
      "<script>alert(1)</script>")

for bad in ("../../etc/passwd", "NRG/../x", "a b", "id;DROP", "NRG'1", "x" * 40, "•id"):
    rejects("text", f"patient_id={bad!r}", base(patient_id=bad), "patient_id")
check("text", "a normal patient_id passes", accepts("text", "NRG1020", base(patient_id="NRG1020"))["patient_id"], "NRG1020")
check("text", "absent patient_id is None (server allocates)", accepts("text", "no patient_id", base())["patient_id"], None)

# Case and surrounding whitespace ARE tolerated — a queued record from an older
# build, or a hand-built curl, should not fail over a trailing space.
check("enum", "trailing space on an enum is tolerated",
      accepts("enum", "'Never '", base(tobacco="Never "))["tobacco"], "never")

# An IDENTIFIER gets the opposite treatment: never silently rewritten. Stripping
# the tab out of "a\tb" would file the record under a client_uuid the phone has
# never seen, so it would re-upload on every sync for the rest of time.
for bad in ("has space", "x" * 80, "uuid/../x", "a\tb", "u\x00id"):
    rejects("text", f"client_uuid={bad!r}", base(client_uuid=bad), "client_uuid")
# Both formats the app can produce: crypto.randomUUID(), and the older fallback.
for good in ("11111111-2222-3333-4444-555555555555", "u-1787773919953-a1b2c3"):
    check("text", f"client_uuid {good!r} accepted", accepts("text", good, base(client_uuid=good))["client_uuid"], good)

for bad in ("20-08-2026", "not-a-date", "2026-13-01", "2026-02-30", 20260820, "", "1999-12-31"):
    rejects("date", f"screened_on={bad!r}", base(screened_on=bad), "screened_on")
future = (date.today() + timedelta(days=30)).isoformat()
rejects("date", f"screened_on {future} is in the future", base(screened_on=future), "screened_on")
# +1 day of slack, for a phone clock that runs fast or a timezone ahead of us.
tomorrow = (date.today() + timedelta(days=1)).isoformat()
check("date", "tomorrow is allowed (clock skew)", accepts("date", tomorrow, base(screened_on=tomorrow))["screened_on"], tomorrow)
check("date", "absent screened_on defaults to today",
      accepts("date", "no date", {k: v for k, v in base().items() if k != "screened_on"})["screened_on"],
      date.today().isoformat())

# ---------------------------------------------------------------------------
# 8. Whitelist. The output is built up field by field, so a key nobody asked for
#    cannot ride along into the INSERT. Unknown keys are IGNORED rather than
#    rejected, because a record queued by an older build of the app must still be
#    able to sync — stranding a real clinical record on a phone is the worse bug.
# ---------------------------------------------------------------------------
c = accepts("whitelist", "payload with junk keys",
            base(is_synthetic=0, id=1, admin=True, __proto__="x", synced_at="1999-01-01"))
if c:
    KNOWN = {"age", "sex", "waist_cm", "activity_level", "active_minutes_week",
             "parents_with_diabetes", "family_history", "tobacco", "alcohol",
             "sbp", "dbp", "fbs", "lat", "lon", "name", "village",
             "patient_id", "client_uuid", "screened_on", *validate.PART_B}
    check("whitelist", "no unknown key survives", sorted(set(c) - KNOWN), [])
    check("whitelist", "every known field is present", sorted(KNOWN - set(c)), [])
    check("whitelist", "is_synthetic cannot be overridden", "is_synthetic" in c, False)

# ---------------------------------------------------------------------------
# 9. THE THEOREM. Either validation refuses the payload, or risk.assess()
#    survives it. Never a third outcome.
#
#    This is the assertion that actually protects the demo. It does not care which
#    field was wrong or what the message said; it says that no combination of
#    hostile values can reach the scorer and raise. Every 500 the API used to
#    return for a bad screening would fail here.
# ---------------------------------------------------------------------------
HOSTILE = {
    "age": [52, 0, -5, 121, "fifty", "", None, True, False, 45.5, float("nan"),
            float("inf"), [], {}, "52", 1e308, -0.0, "0x10", " 52 "],
    "sex": ["F", "M", "f", "x", "", None, 1, True, [], "MF", "Other", "female"],
    "waist_cm": [88.5, 0, -1, 1e9, "88.5", "", None, True, [], float("nan"), 39, 161],
    "tobacco": ["never", "current", "former", "vape", "", None, 0, True, [], "NEVER"],
    "activity_level": ["sedentary", "moderate", "low", "high", "", None, 1, [], "VIGOROUS"],
    "active_minutes_week": [20, 0, -1, 1e9, "20", "", None, True, [], 10081],
    "parents_with_diabetes": [0, 1, 2, 3, -1, 1.5, "1", "two", None, True, []],
    "family_history": [True, False, 1, 0, "yes", "maybe", None, 2, []],
    "alcohol": [True, False, 1, 0, "no", "perhaps", None, -1, {}],
    "sbp": [138, None, 0, 500, "138", "high", [], float("inf")],
    "fbs": [132, None, 19, 601, "132", "sweet", [], True],
    "name": ["Sunita", "", None, "x" * 500, 42, [], "ಸುನೀತಾ", "<img onerror=x>"],
    "patient_id": [None, "NRG1020", "../../etc/passwd", "", "x" * 99, 42, []],
    "screened_on": ["2026-08-20", None, "", "tomorrow", 20260820, "2099-01-01", []],
    "client_uuid": [None, "abc-123", "", "x" * 99, 42, "has space"],
}

PART_B_HOSTILE = [True, False, None, 1, 0, "yes", 7, "maybe", []]
FUZZ_FIELDS = list(HOSTILE)

rng = random.Random(20260827)   # fixed seed: a failure here must be reproducible
rejected = accepted = 0
for i in range(4000):
    # Four generation modes, cycled. Fully-random payloads (mode 3) almost never
    # come out valid — 15 independent fields, each hostile about half the time —
    # so on their own they would never reach risk.assess at all and the theorem's
    # second half would go unchecked. Modes 0-2 start from a VALID screening and
    # corrupt 0, 1 or 2 fields, which is both the realistic case and the one that
    # isolates a single bad field.
    mode = i % 4
    if mode == 3:
        payload = {f: rng.choice(v) for f, v in HOSTILE.items()}
        for f in validate.PART_B:
            payload[f] = rng.choice(PART_B_HOSTILE)
    else:
        payload = base()
        for f in rng.sample(FUZZ_FIELDS, mode):
            payload[f] = rng.choice(HOSTILE[f])
        if mode and rng.random() < 0.5:
            payload[rng.choice(validate.PART_B)] = rng.choice(PART_B_HOSTILE)

    groups["theorem"] = groups.get("theorem", 0) + 1
    try:
        cleaned = clean_screening(payload)
    except Invalid:
        rejected += 1
        continue
    except Exception as e:
        failures.append(("theorem", f"clean_screening raised {type(e).__name__}", repr(payload), "Invalid"))
        sys.stderr.write(f"\n  FAIL [theorem] clean_screening raised {type(e).__name__}: {e}\n"
                         f"    payload {payload!r}\n")
        continue
    accepted += 1
    try:
        a = risk.assess(cleaned)
    except Exception as e:
        failures.append(("theorem", f"risk.assess raised {type(e).__name__}", repr(cleaned), "an assessment"))
        sys.stderr.write(f"\n  FAIL [theorem] accepted payload broke risk.assess: "
                         f"{type(e).__name__}: {e}\n    cleaned {cleaned!r}\n")
        continue
    # A cleaned payload must also produce a SERIALISABLE assessment. allow_nan
    # False is what app.py uses, so a NaN that got this far fails here rather
    # than reaching a client that cannot parse the response.
    try:
        json.dumps(a, allow_nan=False)
    except (ValueError, TypeError) as e:
        failures.append(("theorem", f"assessment is not JSON-serialisable: {e}", repr(cleaned), "clean JSON"))
    for key in ("cbac_score", "idrs_score", "ml_diabetes_risk"):
        if not math.isfinite(a[key]):
            failures.append(("theorem", f"{key} is not finite", a[key], "a finite number"))

# Both branches must be exercised, or the loop proves nothing: all-rejected would
# never call risk.assess at all, and all-accepted would never test a rejection.
check("theorem", "hostile payloads were rejected", rejected > 500, True)
check("theorem", "valid combinations reached the scorer", accepted > 500, True)

# ---------------------------------------------------------------------------
# 10. Query strings
# ---------------------------------------------------------------------------
def limit_rejects(label, raw):
    groups["limit"] = groups.get("limit", 0) + 1
    try:
        clean_limit(raw)
    except Invalid:
        return
    failures.append(("limit", label, "ACCEPTED", "Invalid"))
    sys.stderr.write(f"\n  FAIL [limit] {label}: was ACCEPTED\n")


check("limit", "absent limit defaults", clean_limit(None), validate.DEFAULT_LIMIT)
check("limit", "empty limit defaults", clean_limit(""), validate.DEFAULT_LIMIT)
check("limit", "a normal limit passes", clean_limit("60"), 60)
check("limit", "the cap itself passes", clean_limit(str(validate.MAX_LIMIT)), validate.MAX_LIMIT)
limit_rejects("limit=abc was a 500 with a leaked ValueError", "abc")
# SQLite reads a NEGATIVE limit as UNLIMITED, so ?limit=-1 returned all 1202 rows.
limit_rejects("limit=-1 (SQLite reads it as unlimited)", "-1")
limit_rejects("limit=0", "0")
limit_rejects("limit over the cap", str(validate.MAX_LIMIT + 1))
limit_rejects("limit=99999999 returned the whole table", "99999999")
limit_rejects("limit=1e9", "1e9")
limit_rejects("limit=2.5", "2.5")
limit_rejects("limit as a NaN", "nan")

check("query", "band is upper-cased", clean_query({"band": "high"})["band"], "HIGH")
check("query", "refer=1 becomes a flag", clean_query({"refer": "1"})["refer"], True)
check("query", "refer=0 is ignored", "refer" in clean_query({"refer": "0"}), False)
check("query", "an absent filter is absent", "village" in clean_query({}), False)
for bad in ({"band": "URGENT"}, {"q": "x" * 200}, {"village": "v" * 200}, {"limit": "abc"}):
    groups["query"] = groups.get("query", 0) + 1
    try:
        clean_query(bad)
        failures.append(("query", f"{bad!r} accepted", "ACCEPTED", "Invalid"))
        sys.stderr.write(f"\n  FAIL [query] {bad!r} was ACCEPTED\n")
    except Invalid:
        pass

# ---------------------------------------------------------------------------
# 11. Mutation check: prove this file can actually fail.
#     A test suite that has never been seen to go red is a decoration. This
#     breaks the age bound on purpose and asserts the rejection stops working.
# ---------------------------------------------------------------------------
saved = validate.BOUNDS["age"]
validate.BOUNDS["age"] = (-1000, 1000, True)
mutation_caught = False
try:
    clean_screening(base(age=-5))
except Invalid:
    mutation_caught = True
validate.BOUNDS["age"] = saved
check("mutation", "widening the age bound lets age=-5 through (so the check is real)",
      mutation_caught, False)
# ...and it must go straight back to rejecting once restored.
rejects("mutation", "age=-5 rejected again after restore", base(age=-5), "age")

# ---------------------------------------------------------------------------
total = sum(groups.values())
print(f"\nValidation: {total} assertions across {len(groups)} groups")
for g, n in groups.items():
    print(f"  {n:5d}  {g}")
print(f"  theorem: {rejected} payloads rejected, {accepted} accepted and scored cleanly")

if failures:
    print(f"\n{len(failures)} FAILURE(S).", file=sys.stderr)
    print("An unvalidated field either 500s the API or stores a clinically "
          "impossible record. Both are disqualifying.", file=sys.stderr)
    sys.exit(1)
# ASCII only in this line: a Windows console defaults to cp1252 and would render
# an em dash as a replacement character, which reads as a bug on a projector.
print("VALIDATION OK - nothing reaches the scorer or the database unchecked.\n")

"""
Server-side input validation. Python standard library ONLY.

WHY THIS FILE EXISTS. The screening form in web/js/app.js already enforces every
range in here — `min="1" max="120"` on age, VOICE_RANGE on the spoken path. That
is a usability feature, not a security boundary: it lives on the client, and
anything on the client can be skipped by posting straight to /api/screen. Before
this module, the server took whatever arrived and handed it to risk.py, which
produced three distinct classes of failure:

  {"age": "fifty"}       -> TypeError inside cbac_score, HTTP 500
  {"tobacco": "vape"}    -> KeyError inside cbac_score, HTTP 500
  {"age": -5, "waist": 0} -> scored happily and STORED. No exception, no
                             complaint, and a clinical record that says a
                             minus-five-year-old has a zero-centimetre waist.

The third is the one that matters. A 500 is loud and gets fixed; a plausible-
looking row in a clinical table is silent and permanent.

TWO RULES the rest of the server depends on:

  1. Nothing reaches risk.py or SQLite that has not been through clean_screening().
  2. A rejection names the FIELD and says what was wrong with it. "Invalid input"
     is useless to an ASHA holding a phone, and useless to us on stage. The
     message is written to be read out loud.

Bounds are deliberately the same numbers as VOICE_RANGE and the form's min/max in
web/js/app.js. If you change one, change both — a value the keyboard refuses must
not be admissible through the API, or the two disagree about what a valid reading
is and the stricter one looks broken.
"""

from datetime import date, timedelta

SEX = ("M", "F")
TOBACCO = ("never", "former", "current")
ACTIVITY = ("vigorous", "moderate", "mild", "sedentary")
PARENTS = (0, 1, 2)

# (low, high, whole-number-only). Matched to web/js/app.js — see module docstring.
BOUNDS = {
    "age": (1, 120, True),
    "waist_cm": (40, 160, False),        # step 0.5 in the UI, so not integer-only
    "active_minutes_week": (0, 10080, True),   # 10080 = minutes in a week
    "sbp": (60, 260, True),
    "dbp": (30, 180, True),
    "fbs": (20, 600, True),
    "lat": (-90, 90, False),
    "lon": (-180, 180, False),
}

REQUIRED = ("age", "sex", "waist_cm", "tobacco", "active_minutes_week")
OPTIONAL_NUMBERS = ("sbp", "dbp", "fbs", "lat", "lon")

# CBAC Part B symptom flags. Duplicated from risk.CBAC_PART_B rather than
# imported, so validation has no dependency on the scoring module and can be
# tested on its own.
PART_B = (
    "persistent_cough_2wk",
    "shortness_of_breath",
    "unexplained_weight_loss",
    "lump_or_sore_not_healing",
    "difficulty_opening_mouth",
)

MAX_NAME = 120
MAX_VILLAGE = 80
MAX_ID = 32
MAX_UUID = 64
MAX_LIMIT = 500          # a phone renders 60; nothing legitimate asks for more
DEFAULT_LIMIT = 200
MAX_QUERY = 64           # free-text search box
MAX_BATCH = 500          # queued screenings accepted in one /api/sync call

EARLIEST_SCREENING = date(2000, 1, 1)

ID_CHARS = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
UUID_CHARS = ID_CHARS | set(".:")


class Invalid(Exception):
    """One or more field-level problems.

    Collects EVERY problem rather than raising on the first. An ASHA re-entering
    a rejected record should be told about all three bad fields at once, not made
    to discover them one submit at a time.
    """

    def __init__(self, fields):
        self.fields = fields
        super().__init__("; ".join(f"{f['field']}: {f['message']}" for f in fields))


def _fmt(v):
    """Echo the offending value back, truncated. Seeing what the server actually
    received is most of the diagnosis, but an untruncated echo would let a caller
    choose the size of our error responses."""
    s = repr(v)
    return s if len(s) <= 60 else s[:57] + "..."


def _number(raw, lo, hi, whole):
    """A finite number inside [lo, hi], or ValueError with a readable reason."""
    # bool BEFORE int: isinstance(True, int) is True in Python, so `"age": true`
    # would otherwise sail through as the age 1.
    if isinstance(raw, bool):
        raise ValueError("expected a number, got true/false")
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            raise ValueError("is empty")
        try:
            raw = float(s)
        except ValueError:
            raise ValueError(f"{_fmt(s)} is not a number")
    if not isinstance(raw, (int, float)):
        raise ValueError(f"expected a number, got {type(raw).__name__}")
    v = float(raw)
    # NaN and Infinity are not hypothetical: json.loads accepts the bare literals
    # NaN, Infinity and -Infinity by default. A NaN age makes every comparison in
    # cbac_score() false, silently scoring as the oldest band, and then json.dumps
    # emits `NaN` — which is not valid JSON, so the app's JSON.parse throws and the
    # ASHA sees a generic failure with no cause. _body() rejects these at the parse
    # boundary as well; this is the second line.
    if v != v or v in (float("inf"), float("-inf")):
        raise ValueError("is not a finite number")
    if whole:
        if v != int(v):
            raise ValueError(f"must be a whole number, got {_fmt(raw)}")
        v = int(v)
    if not lo <= v <= hi:
        raise ValueError(f"{_fmt(raw)} is outside the plausible range {lo}-{hi}")
    return v


_TRUE = {"1", "true", "yes", "y", "on"}
_FALSE = {"0", "false", "no", "n", "off", ""}


def _flag(raw):
    """A boolean. Tolerant of the shapes an older queued record might hold."""
    if raw is None:
        return False
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (int, float)):
        if raw in (0, 1):
            return bool(raw)
        raise ValueError(f"{_fmt(raw)} is not a yes/no value")
    if isinstance(raw, str):
        s = raw.strip().lower()
        if s in _TRUE:
            return True
        if s in _FALSE:
            return False
    raise ValueError(f"{_fmt(raw)} is not a yes/no value")


def _text(raw, cap, field):
    """A single-line string, length-capped, control characters stripped.

    Not an XSS defence — the app builds DOM with createTextNode and has no
    innerHTML sink, so markup here is inert. This is about the OTHER consumers of
    a name: a CSV export, a printed referral slip, a server log line. An embedded
    newline or NUL breaks all three, and none of them are the place to discover it.
    """
    if raw is None:
        return ""
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        raw = str(raw)
    if not isinstance(raw, str):
        raise ValueError(f"expected text, got {type(raw).__name__}")
    s = "".join(ch for ch in raw if ch == " " or ch.isprintable()).strip()
    if len(s) > cap:
        raise ValueError(f"is longer than the {cap}-character limit for {field}")
    return s


def _token(raw, cap, allowed, field):
    """An identifier: printable, capped, and drawn from a known character set.

    Stricter than _text on purpose. _text SILENTLY strips control characters,
    which is right for a name but wrong for an identifier: client_uuid is the
    idempotency key, so quietly turning "a<tab>b" into "ab" would store the record
    under a key the phone has never heard of, the applied list would come back
    with a uuid that matches nothing in the queue, and that record would re-upload
    on every sync forever. An id is either exactly what was sent, or refused.
    """
    if not isinstance(raw, str):
        s = _text(raw, cap, field)
    else:
        s = raw.strip()
        if len(s) > cap:
            raise ValueError(f"is longer than the {cap}-character limit for {field}")
    if not s:
        raise ValueError("is empty")
    bad = sorted(set(s) - allowed)
    if bad:
        raise ValueError("contains characters that are not allowed: "
                         + repr("".join(ch if ch.isprintable() else f"\\x{ord(ch):02x}"
                                       for ch in bad)))
    return s


def _iso_date(raw):
    """A screening date. Bounded on BOTH sides, and the future bound is the one
    that earns its keep: the patient detail page orders visits by screened_on, so
    a record dated 2031 pins itself to the end of the trend for the next five
    years and the deterioration alert compares against the wrong baseline."""
    if not isinstance(raw, str):
        raise ValueError(f"expected a YYYY-MM-DD date, got {type(raw).__name__}")
    s = raw.strip()[:10]
    try:
        d = date.fromisoformat(s)
    except ValueError:
        raise ValueError(f"{_fmt(raw)} is not a YYYY-MM-DD date")
    # +1 day of slack: a phone with a slightly fast clock, or an ASHA in a
    # timezone ahead of the server, must not have its records refused.
    if d > date.today() + timedelta(days=1):
        raise ValueError(f"{s} is in the future — check the device date")
    if d < EARLIEST_SCREENING:
        raise ValueError(f"{s} is before {EARLIEST_SCREENING.isoformat()}")
    return d.isoformat()


def clean_screening(payload):
    """Validate and normalise one screening.

    Returns a NEW dict containing only known fields — a whitelist, so nothing
    unexpected can reach the INSERT. Unknown keys are ignored rather than
    rejected: a record queued offline by an older build of the app must still
    sync, and refusing it would strand a real clinical record on a phone.

    Raises Invalid with every problem found.
    """
    if not isinstance(payload, dict):
        raise Invalid([{"field": "_body",
                        "message": f"expected a JSON object, got {type(payload).__name__}"}])

    errors = []
    out = {}

    def take(field, fn, *, default=None, missing_ok=False):
        raw = payload.get(field)
        if raw is None or (isinstance(raw, str) and not raw.strip()):
            if missing_ok:
                out[field] = default
                return
            errors.append({"field": field, "message": "is required"})
            return
        try:
            out[field] = fn(raw)
        except ValueError as ex:
            errors.append({"field": field, "message": str(ex)})

    def enum(field, allowed, *, default=None, upper=False, lower=False):
        raw = payload.get(field)
        if raw is None or (isinstance(raw, str) and not raw.strip()):
            if default is None:
                errors.append({"field": field, "message": "is required"})
            else:
                out[field] = default
            return
        if not isinstance(raw, str):
            errors.append({"field": field,
                           "message": f"expected one of {', '.join(allowed)}, got {type(raw).__name__}"})
            return
        v = raw.strip()
        if upper:
            v = v.upper()
        if lower:
            v = v.lower()
        if v not in allowed:
            errors.append({"field": field,
                           "message": f"{_fmt(raw)} is not one of: {', '.join(allowed)}"})
            return
        out[field] = v

    # ---- required clinical fields ----------------------------------------
    for field in ("age", "waist_cm", "active_minutes_week"):
        lo, hi, whole = BOUNDS[field]
        take(field, lambda r, lo=lo, hi=hi, whole=whole: _number(r, lo, hi, whole))
    enum("sex", SEX, upper=True)
    enum("tobacco", TOBACCO, lower=True)

    # ---- fields with a safe default --------------------------------------
    enum("activity_level", ACTIVITY, default="moderate", lower=True)

    raw_parents = payload.get("parents_with_diabetes")
    if raw_parents is None or (isinstance(raw_parents, str) and not raw_parents.strip()):
        out["parents_with_diabetes"] = 0
    else:
        try:
            # Indexes a dict in risk.idrs_score, so 0/1/2 exactly — 3 is a KeyError
            # and 1.5 an unhashable-in-practice miss.
            n = _number(raw_parents, 0, 2, True)
            if n not in PARENTS:
                raise ValueError(f"{_fmt(raw_parents)} must be 0, 1 or 2")
            out["parents_with_diabetes"] = n
        except ValueError as ex:
            errors.append({"field": "parents_with_diabetes", "message": str(ex)})

    for field, default in (("alcohol", False), *((k, False) for k in PART_B)):
        try:
            out[field] = _flag(payload.get(field, default))
        except ValueError as ex:
            errors.append({"field": field, "message": str(ex)})

    # family_history defaults FROM parents_with_diabetes, so it has to run after
    # it. Both are CBAC inputs and disagreeing is not a possible clinical state.
    if payload.get("family_history") is None:
        out["family_history"] = bool(out.get("parents_with_diabetes") or 0)
    else:
        try:
            out["family_history"] = _flag(payload["family_history"])
        except ValueError as ex:
            errors.append({"field": "family_history", "message": str(ex)})

    # ---- optional measurements -------------------------------------------
    for field in OPTIONAL_NUMBERS:
        lo, hi, whole = BOUNDS[field]
        take(field, lambda r, lo=lo, hi=hi, whole=whole: _number(r, lo, hi, whole),
             default=None, missing_ok=True)

    # ---- identity and provenance -----------------------------------------
    try:
        out["name"] = _text(payload.get("name"), MAX_NAME, "name") or "Unnamed"
    except ValueError as ex:
        errors.append({"field": "name", "message": str(ex)})
    try:
        out["village"] = _text(payload.get("village"), MAX_VILLAGE, "village") or "Unknown"
    except ValueError as ex:
        errors.append({"field": "village", "message": str(ex)})

    for field, cap, chars in (("patient_id", MAX_ID, ID_CHARS),
                              ("client_uuid", MAX_UUID, UUID_CHARS)):
        raw = payload.get(field)
        if raw is None or (isinstance(raw, str) and not raw.strip()):
            out[field] = None
            continue
        try:
            out[field] = _token(raw, cap, chars, field)
        except ValueError as ex:
            errors.append({"field": field, "message": str(ex)})

    if payload.get("screened_on") is None:
        out["screened_on"] = date.today().isoformat()
    else:
        try:
            out["screened_on"] = _iso_date(payload["screened_on"])
        except ValueError as ex:
            errors.append({"field": "screened_on", "message": str(ex)})

    if errors:
        raise Invalid(errors)
    return out


# ---------------------------------------------------------------------------
# Query-string validation for the read endpoints
# ---------------------------------------------------------------------------

def clean_limit(raw):
    """A row limit that cannot be turned into a denial of service.

    Two live defects, both from `int(q.get("limit", 200))` with nothing around it:

      ?limit=abc      -> ValueError, HTTP 500, Python traceback text in the body
      ?limit=-1       -> SQLite reads a NEGATIVE LIMIT as UNLIMITED and returned
                         all 1202 rows; ?limit=99999999 returned the whole table
                         as a 960 KB response. Either one, in a loop, is the
                         cheapest possible way to flatten a laptop mid-demo.
    """
    if raw is None or raw == "":
        return DEFAULT_LIMIT
    try:
        n = int(_number(raw, 1, MAX_LIMIT, True))
    except ValueError as ex:
        raise Invalid([{"field": "limit", "message": str(ex)}])
    return n


def clean_patient_id(raw):
    """A patient id from a URL path segment."""
    try:
        return _token(raw, MAX_ID, ID_CHARS, "patient_id")
    except ValueError as ex:
        raise Invalid([{"field": "patient_id", "message": str(ex)}])


def clean_query(params):
    """The roster filters. Every value is already passed to SQLite as a bound
    parameter, so this is not about injection — it is about length and shape, so
    a filter cannot be used to build a 10 MB LIKE pattern or a nonsense band that
    silently matches nothing."""
    out = {}
    errors = []
    try:
        out["limit"] = clean_limit(params.get("limit"))
    except Invalid as ex:
        errors.extend(ex.fields)
    for field, cap in (("village", MAX_VILLAGE), ("q", MAX_QUERY)):
        if params.get(field):
            try:
                out[field] = _text(params[field], cap, field)
            except ValueError as ex:
                errors.append({"field": field, "message": str(ex)})
    if params.get("band"):
        band = str(params["band"]).strip().upper()
        if band not in ("HIGH", "MODERATE", "LOW"):
            errors.append({"field": "band", "message": f"{_fmt(params['band'])} is not HIGH, MODERATE or LOW"})
        else:
            out["band"] = band
    if params.get("refer") == "1":
        out["refer"] = True
    if errors:
        raise Invalid(errors)
    return out

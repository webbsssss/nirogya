"""
Nirogya shared risk logic — CBAC + IDRS deterministic floor, ML layer on top.

This module is the single source of truth for scoring. web/js/risk.js is a
line-for-line port of it so the phone can score OFFLINE, and tests/parity_test.js
verifies the two agree. If you change scoring here, change it there and re-run
the parity test.

Zero dependencies. Python 3.8+.
"""

import json
import math
from pathlib import Path

WEIGHTS_PATH = Path(__file__).resolve().parent.parent / "web" / "data" / "model_weights.json"

# ---------------------------------------------------------------------------
# CBAC — Community Based Assessment Checklist (MoHFW, NP-NCD programme)
# ---------------------------------------------------------------------------
# !! VERIFY these per-item weights against the official MoHFW CBAC operational
# guideline PDF before you pitch. The >=4 referral cut-off is stable and widely
# cited; individual item point values vary between state versions.

def cbac_score(p):
    b = {}
    age = p["age"]
    b["age"] = 0 if age < 40 else 1 if age < 50 else 2 if age < 60 else 3
    b["family_history"] = 2 if p.get("family_history") else 0
    b["tobacco"] = {"never": 0, "former": 1, "current": 2}[p["tobacco"]]
    b["alcohol"] = 1 if p.get("alcohol") else 0
    w = p["waist_cm"]
    if p["sex"] == "F":
        b["waist"] = 0 if w < 80 else 1 if w <= 90 else 2
    else:
        b["waist"] = 0 if w < 90 else 1 if w <= 100 else 2
    b["physical_inactivity"] = 0 if p["active_minutes_week"] >= 150 else 1
    return sum(b.values()), b


CBAC_PART_B = [
    "persistent_cough_2wk",
    "shortness_of_breath",
    "unexplained_weight_loss",
    "lump_or_sore_not_healing",
    "difficulty_opening_mouth",
]

PART_B_LABELS = {
    "persistent_cough_2wk": "Cough > 2 weeks (TB screen)",
    "shortness_of_breath": "Shortness of breath (COPD screen)",
    "unexplained_weight_loss": "Unexplained weight loss",
    "lump_or_sore_not_healing": "Lump / non-healing sore (cancer screen)",
    "difficulty_opening_mouth": "Difficulty opening mouth (oral cancer screen)",
}


def cbac_part_b_flag(p):
    hits = [k for k in CBAC_PART_B if p.get(k)]
    return (len(hits) > 0), hits


# ---------------------------------------------------------------------------
# IDRS — Indian Diabetes Risk Score (Madras Diabetes Research Foundation)
# ---------------------------------------------------------------------------
# Validated in Indian cohorts. This is what answers "why should this work on
# Indians?" — verify bands against MDRF / Mohan et al. before pitching.

def idrs_score(p):
    b = {}
    age = p["age"]
    b["age"] = 0 if age < 35 else 20 if age < 50 else 30
    w = p["waist_cm"]
    if p["sex"] == "F":
        b["waist"] = 0 if w < 80 else 10 if w < 90 else 20
    else:
        b["waist"] = 0 if w < 90 else 10 if w < 100 else 20
    b["physical_activity"] = {
        "vigorous": 0, "moderate": 10, "mild": 20, "sedentary": 30
    }[p["activity_level"]]
    b["family_history"] = {0: 0, 1: 10, 2: 20}[int(p.get("parents_with_diabetes", 0))]
    return sum(b.values()), b


def idrs_band(s):
    return "high" if s >= 60 else "moderate" if s >= 30 else "low"


# ---------------------------------------------------------------------------
# ML layer — logistic regression on the CBAC feature space ONLY
# ---------------------------------------------------------------------------

FEATURES = ["age", "waist_excess", "is_male", "family_hist_n",
            "tobacco_current", "alcohol", "inactive"]

# Sex-specific abdominal-obesity cut-offs, as used by both CBAC and IDRS.
WAIST_CUTOFF = {"M": 90.0, "F": 80.0}

_weights = None


def weights():
    global _weights
    if _weights is None:
        _weights = json.loads(WEIGHTS_PATH.read_text())
    return _weights


def waist_excess(p):
    """cm above the sex-specific abdominal-obesity cut-off (may be negative).

    Do NOT substitute absolute waist here. Men's baseline waist is higher, so
    with is_male also in the model the waist coefficient flips negative to
    compensate — and the explainability panel then tells a judge, live, that a
    larger waist reduces diabetes risk. Sex-adjusted excess is clinically correct
    and numerically stable. bootstrap.py aborts if this regresses.
    """
    return float(p["waist_cm"]) - WAIST_CUTOFF[p["sex"]]


def featurise(p):
    return [
        float(p["age"]),
        waist_excess(p),
        1.0 if p["sex"] == "M" else 0.0,
        float(p.get("parents_with_diabetes", 0)),
        1.0 if p["tobacco"] == "current" else 0.0,
        1.0 if p.get("alcohol") else 0.0,
        1.0 if p["active_minutes_week"] < 150 else 0.0,
    ]


def predict(model, p):
    x = featurise(p)
    z = [(v - m) / s for v, m, s in zip(x, model["mu"], model["sd"])]
    logit = sum(w * zi for w, zi in zip(model["w"], z)) + model["b"]
    prob = 1.0 / (1.0 + math.exp(-logit))
    contrib = sorted(
        ((f, w * zi) for f, w, zi in zip(model["features"], model["w"], z)),
        key=lambda t: -abs(t[1]),
    )
    return prob, contrib


def describe_driver(feature, contribution, p):
    """Always render the PATIENT'S ACTUAL VALUE, never the bare feature name.

    Naming the feature alone produces sentences like "Physical inactivity reduces
    risk" for a patient who is in fact active — mathematically correct (value
    below cohort mean) but it reads as a broken model, and that is exactly what a
    judge pounces on.

    Numbers are formatted explicitly (:.1f, int()) rather than relying on repr,
    so web/js/risk.js can produce byte-identical strings and tests/parity_test.js
    can compare them directly. Without this, 99 vs 99.0 breaks parity.
    """
    we = waist_excess(p)
    v = {
        "age": f"Age {int(p['age'])}",
        "waist_excess": (
            f"Waist {float(p['waist_cm']):.1f} cm — {abs(we):.1f} cm "
            f"{'above' if we >= 0 else 'below'} the "
            f"{int(WAIST_CUTOFF[p['sex']])} cm cut-off"),
        "is_male": "Male" if p["sex"] == "M" else "Female",
        "family_hist_n": (
            f"Family history: {int(p.get('parents_with_diabetes', 0))} parent(s) with diabetes"
            if int(p.get("parents_with_diabetes", 0)) else "No family history of diabetes"),
        "tobacco_current": ("Current tobacco use" if p["tobacco"] == "current"
                            else f"Tobacco: {p['tobacco']}"),
        "alcohol": "Alcohol use" if p.get("alcohol") else "No alcohol use",
        "inactive": (f"Physically inactive ({int(p['active_minutes_week'])} min/week)"
                     if p["active_minutes_week"] < 150
                     else f"Physically active ({int(p['active_minutes_week'])} min/week)"),
    }[feature]
    return f"{v} — {'increases' if contribution > 0 else 'reduces'} risk"


# ---------------------------------------------------------------------------
# Combined assessment
# ---------------------------------------------------------------------------

def assess(p):
    """Deterministic government rules form a FLOOR the model cannot override.

    This is the answer to "what if your AI is wrong about someone?" — the model
    can only ever ADD a referral, never remove one CBAC/IDRS require. Worst case
    it over-refers. It can never under-refer relative to current practice.

    BANDING. CBAC >=4 fires for ~45% of adults 30+ (it is deliberately
    age-weighted). No PHC can absorb that, so a flat referral list is not
    actionable. The band is therefore a PRIORITY ORDERING INSIDE the referral
    floor, not a second gate that removes anyone:

      HIGH     - a CBAC Part B red flag (possible TB / COPD / cancer: urgent
                 regardless of any score), OR referred AND in the top slice of
                 model diabetes risk. The cut-off is an absolute probability
                 baked into model_weights.json at training time, so on-device
                 scoring stays a pure function of one patient and needs no
                 population context.
      MODERATE - referred by the deterministic rules, but not top-slice.
      LOW      - no referral criterion met.

    Nobody referred by CBAC/IDRS is ever dropped to LOW. HIGH only reorders.
    """
    W = weights()
    cbac, cbac_items = cbac_score(p)
    partb, partb_hits = cbac_part_b_flag(p)
    idrs, idrs_items = idrs_score(p)
    dm_prob, dm_contrib = predict(W["diabetes"], p)
    htn_prob, _ = predict(W["hypertension"], p)

    reasons = []
    if cbac >= 4:
        reasons.append(f"CBAC score {cbac} ≥ 4 (MoHFW referral criterion)")
    if partb:
        reasons.append("CBAC Part B: " + ", ".join(PART_B_LABELS[h] for h in partb_hits))
    if idrs >= 60:
        reasons.append(f"IDRS {idrs} ≥ 60 (high risk, MDRF)")
    high_thr = (W.get("bands") or {}).get("high_dm_prob", 0.5)
    if dm_prob >= high_thr:
        reasons.append(f"ML diabetes risk {round(dm_prob*100)}% (top-risk slice)")

    if partb:
        band = "HIGH"
    elif reasons and dm_prob >= high_thr:
        band = "HIGH"
    elif reasons:
        band = "MODERATE"
    else:
        band = "LOW"

    return {
        "cbac_score": cbac,
        "cbac_items": cbac_items,
        "cbac_part_b": partb_hits,
        "idrs_score": idrs,
        "idrs_band": idrs_band(idrs),
        "idrs_items": idrs_items,
        "ml_diabetes_risk": round(dm_prob, 4),
        "ml_hypertension_risk": round(htn_prob, 4),
        "high_risk_threshold": high_thr,
        "risk_band": band,
        "refer": bool(reasons),
        "referral_reasons": reasons,
        "top_drivers": [
            {"feature": f, "contribution": round(c, 4), "label": describe_driver(f, c, p)}
            for f, c in dm_contrib[:3]
        ],
    }

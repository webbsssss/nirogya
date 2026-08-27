"""
One-shot bootstrap: generate synthetic cohort -> train model -> write weights
-> build SQLite DB (incl. 6-month history for the trend demo).

Run once:  python3 server/bootstrap.py
Zero dependencies.

THE COHORT IS SYNTHETIC. It is labelled as such in the DB, in the API responses
and in the UI. Do not describe it as field data. Judges respect "synthetic,
calibrated to published marginals, labelled on screen" far more than they punish
it — and claiming real data you don't have is the one thing that can actually
sink you.
"""

import csv
import json
import math
import os
import random
import sqlite3
from datetime import date, timedelta
from pathlib import Path

random.seed(7)  # reproducible — a judge may ask you to re-run it

# ---------------------------------------------------------------------------
# Calibration constants — hoisted so they can be tuned without hunting through
# the generator. N=1200 is not vanity: at N=400 the tobacco-current subgroup was
# 29 people, so a real risk effect was smaller than the sampling noise and the
# model learned a NEGATIVE tobacco coefficient purely by chance. If you shrink
# the cohort, shrink the feature set too. 1200 across 8 villages (~150 each) is
# also a plausible size for a district pilot, which helps in Q&A.
# ---------------------------------------------------------------------------
N_COHORT = 1200
EPOCHS = 2500

# Binary risk factors need effect sizes big enough to survive finite-sample
# noise, since each one only covers 10-25% of the cohort.
EFF_AGE = 0.055          # per year above 40
EFF_WAIST = 0.085        # per cm above the sex-specific cut-off
EFF_FAMHX = 0.75         # per affected parent
EFF_TOBACCO = 0.68       # current tobacco use
EFF_INACTIVE = 0.70      # <150 min/week
EFF_DEPRIVATION = 1.10   # per unit of village deprivation multiplier
INTERCEPT = -2.70        # tunes overall diabetes prevalence (target 8-18%)

ROOT = Path(__file__).resolve().parent.parent
# Override with NIROGYA_DB if the repo lives on a mount that doesn't support
# SQLite locking (network shares, some VM mounts -> "disk I/O error").
DB = Path(os.environ.get("NIROGYA_DB") or (ROOT / "server" / "nirogya.db"))
WEIGHTS = ROOT / "web" / "data" / "model_weights.json"


def stable_floats(o, places=12):
    """Round every float in a nested structure, so the weights file this module
    writes is byte-identical on every machine.

    Training is already deterministic: fixed seed, same cohort, same
    coefficients to every digit that matters. But `math.exp` and `math.log` are
    only required to be correct to within an accepted error, and platforms differ
    in their last unit of least precision — CPython 3.10 on glibc and CPython
    3.13 on Windows disagree in the 16th significant digit here. That is enough to
    change the FILE while changing nothing whatsoever about the model, so
    model_weights.json flip-flops depending on which teammate ran the harness
    last. The diff is unreviewable and it makes "re-run it and you get exactly the
    artifact we submitted" untrue, which is a claim worth being able to make.

    12 places is ~1000x wider than the drift observed between those two
    interpreters, and ~8 orders of magnitude below the 4-decimal band threshold,
    so it cannot move a patient between risk bands. It is not a mathematical
    guarantee — a value landing exactly on a rounding boundary could still
    differ — but it removes the churn seen in practice.
    """
    if isinstance(o, float):
        return round(o, places)
    if isinstance(o, dict):
        return {k: stable_floats(v, places) for k, v in o.items()}
    if isinstance(o, list):
        return [stable_floats(v, places) for v in o]
    return o

# ---------------------------------------------------------------------------
# Villages — real Udupi district (Karnataka) settlements. Byndoor / Kundapura /
# Shankaranarayana carry a higher deprivation multiplier so the heatmap has a
# genuine cluster to find, rather than uniform noise.
# ---------------------------------------------------------------------------
VILLAGES = [
    ("Hebri", 13.4667, 74.9833, 1.15),
    ("Karkala", 13.2167, 74.9833, 0.95),
    ("Brahmavar", 13.4333, 74.7500, 1.00),
    ("Kaup", 13.2167, 74.7500, 0.90),
    ("Byndoor", 13.8667, 74.6333, 1.30),
    ("Kundapura", 13.6333, 74.6833, 1.20),
    ("Shankaranarayana", 13.6500, 74.8500, 1.25),
    ("Ajekar", 13.3500, 75.0500, 1.05),
]

FIRST_F = ["Lakshmi", "Sharada", "Girija", "Yashoda", "Pushpa", "Sunanda",
           "Kamala", "Vedavathi", "Shobha", "Jayanthi"]
FIRST_M = ["Ganesh", "Shivappa", "Ramesh", "Narayana", "Mohan", "Prakash",
           "Basava", "Ishwar", "Sadananda", "Vasudeva"]
LAST = ["Shetty", "Poojary", "Gowda", "Naik", "Hegde", "Acharya", "Devadiga", "Bhat"]

PART_B = ["persistent_cough_2wk", "shortness_of_breath", "unexplained_weight_loss",
          "lump_or_sore_not_healing", "difficulty_opening_mouth"]

# Per-symptom prevalence. A flat 4% each gave P(any Part B) = 19%, i.e. one in
# five villagers carrying a TB/COPD/cancer red flag — implausible, and it was
# quietly inflating the referral rate. These are individually rare; the oral
# ones are conditioned on tobacco use, since oral submucous fibrosis and
# non-healing oral lesions are overwhelmingly tobacco-driven.
PART_B_BASE = {
    "persistent_cough_2wk": 0.022,
    "shortness_of_breath": 0.020,
    "unexplained_weight_loss": 0.012,
    "lump_or_sore_not_healing": 0.006,
    "difficulty_opening_mouth": 0.004,
}
PART_B_TOBACCO_MULT = {           # applied when tobacco == "current"
    "persistent_cough_2wk": 2.5,
    "shortness_of_breath": 2.0,
    "lump_or_sore_not_healing": 4.0,
    "difficulty_opening_mouth": 6.0,
}


def make_patient(i):
    village, lat, lon, mult = random.choice(VILLAGES)
    sex = random.choice(["M", "F"])
    age = int(random.triangular(30, 78, 46))

    # Female base sits below the 80cm cut-off, male below 90cm. The cut-offs are
    # strict for South Asians, so a high share of women above 80cm is real
    # (ICMR-INDIAB / NFHS-5 put Indian female abdominal obesity around 40-50%) —
    # but 59% was overshooting, so the female base came down from 79 to 77.
    waist_base = 77 if sex == "F" else 85
    # Deprivation shifts waist ADDITIVELY, not multiplicatively. Multiplying the
    # absolute value (waist_base * 1.30) produced a 114cm mean waist for Byndoor,
    # which pushed 63% of the cohort into HIGH risk and 81% into referral --
    # implausible, and a judge would correctly say that's useless for triage.
    waist = round(max(60.0, min(125.0,
                  random.gauss(waist_base + (mult - 1.0) * 20.0, 7.5))), 1)

    # Physical activity. The first version put only ~20% below the WHO 150 min/wk
    # threshold, which is both unrealistic (ICMR-INDIAB/Anjana et al. put Indian
    # physical inactivity near 50%, rural not far behind) and too small a subgroup
    # to learn a stable coefficient from. Raising it to ~40% fixes the realism and
    # the statistical power in one change.
    activity = random.choices(["vigorous", "moderate", "mild", "sedentary"],
                              weights=[3.5, 3.2, 2.6, 1.6 + 2.0 * (mult - 0.9)])[0]
    active_minutes = {"vigorous": 300, "moderate": 180, "mild": 90, "sedentary": 20}[activity]

    parents_dm = random.choices([0, 1, 2], weights=[80, 17, 3])[0]
    # Calibrated to GATS-2 style rural marginals: tobacco use in ANY form
    # (smokeless included — khaini/gutka matter a lot in rural Karnataka), so male
    # current use ~30% and female ~10%. The earlier 7% overall was below even our
    # own plausibility band AND too small a subgroup to learn a coefficient from.
    tobacco = random.choices(
        ["never", "former", "current"],
        weights=[55, 12, 26 + 12 * (mult - 0.9)] if sex == "M"
        else [80, 5, 8 + 5 * (mult - 0.9)])[0]
    alcohol = random.random() < (0.16 * mult if sex == "M" else 0.02)

    sbp = round(random.gauss(118 + (age - 40) * 0.45 + (mult - 1.0) * 10, 13))
    dbp = round(random.gauss(76 + (age - 40) * 0.15 + (mult - 1.0) * 5, 9))

    # Glucose: two-component mixture, because that is how it actually behaves in a
    # population — most adults are normoglycaemic, and a risk-driven minority is
    # dysglycaemic. A single normal distribution put ~48% of the cohort in the
    # 100-125 prediabetes band, roughly triple the ICMR-INDIAB ratio, because its
    # mean sat right on the 100 mg/dL threshold.
    #
    # THE RULE, learned the hard way three times via the sanity gate below: every
    # model feature needs a term here using the IDENTICAL definition risk.py uses.
    # Past failures:
    #   1. glucose independent of family history      -> negative family-history coef
    #   2. glucose keyed to a per-sex waist BASELINE while the feature measured
    #      excess over the per-sex CUT-OFF -> is_male and waist_excess traded off,
    #      flipping the waist coefficient negative
    #   3. glucose keyed to `sedentary` while the feature is `inactive`
    #      (<150 min/wk, so mild counts too), and no tobacco term at all
    #      -> negative tobacco and inactivity coefficients
    #
    # `alcohol` is deliberately left out: its association with T2DM is genuinely
    # J-shaped in the literature, so a near-zero learned coefficient is the honest
    # outcome and the gate does not require it to be positive.
    w_excess = waist - (90.0 if sex == "M" else 80.0)
    latent = (EFF_AGE * (age - 40)
              + EFF_WAIST * w_excess
              + EFF_FAMHX * parents_dm
              + (EFF_TOBACCO if tobacco == "current" else 0.0)
              + (EFF_INACTIVE if active_minutes < 150 else 0.0)
              + EFF_DEPRIVATION * (mult - 1.0)
              + INTERCEPT)
    if random.random() < 1.0 / (1.0 + math.exp(-latent)):
        fbs = round(random.gauss(140, 27))     # dysglycaemic
    else:
        fbs = round(random.gauss(91, 9))       # normoglycaemic

    p = {
        "patient_id": f"NRG{1000 + i}",
        "name": f"{random.choice(FIRST_F if sex == 'F' else FIRST_M)} {random.choice(LAST)}",
        "sex": sex, "age": age, "village": village,
        "lat": round(lat + random.gauss(0, 0.012), 5),
        "lon": round(lon + random.gauss(0, 0.012), 5),
        "waist_cm": waist, "activity_level": activity,
        "active_minutes_week": active_minutes,
        "parents_with_diabetes": parents_dm,
        "family_history": parents_dm > 0,
        "tobacco": tobacco, "alcohol": alcohol,
        "sbp": max(90, min(210, sbp)), "dbp": max(55, min(130, dbp)),
        "fbs": max(65, min(320, fbs)),
    }
    for k in PART_B:
        pr = PART_B_BASE[k] * mult
        if tobacco == "current":
            pr *= PART_B_TOBACCO_MULT.get(k, 1.0)
        p[k] = random.random() < pr
    return p


FEATURES = ["age", "waist_excess", "is_male", "family_hist_n",
            "tobacco_current", "alcohol", "inactive"]

# Abdominal obesity cut-offs (sex-specific, as CBAC and IDRS both use them):
# male 90cm, female 80cm.
WAIST_CUTOFF = {"M": 90.0, "F": 80.0}


def waist_excess(p):
    """cm above the sex-specific abdominal-obesity cut-off (can be negative).

    Using ABSOLUTE waist here is a trap: men's baseline waist is higher, so with
    is_male also in the model the waist coefficient flips NEGATIVE to compensate,
    and the explainability panel then tells a judge that a larger waist reduces
    diabetes risk. Sex-adjusted excess is both clinically correct and stable.
    """
    return float(p["waist_cm"]) - WAIST_CUTOFF[p["sex"]]


def featurise(p):
    return [float(p["age"]), waist_excess(p),
            1.0 if p["sex"] == "M" else 0.0,
            float(p["parents_with_diabetes"]),
            1.0 if p["tobacco"] == "current" else 0.0,
            1.0 if p["alcohol"] else 0.0,
            1.0 if p["active_minutes_week"] < 150 else 0.0]


def train_logreg(X, y, epochs=None, lr=0.05):
    """Plain gradient descent — no sklearn, so this runs anywhere with no install.
    Logistic regression (not XGBoost) is deliberate for the on-device path: the
    coefficients port to ~20 lines of JS, so risk scoring genuinely runs OFFLINE
    on the phone. That makes 'offline-first AI' literally true, not a slide claim."""
    epochs = EPOCHS if epochs is None else epochs
    n, d = len(X), len(X[0])
    mu = [sum(r[j] for r in X) / n for j in range(d)]
    sd = [max(1e-6, (sum((r[j] - mu[j]) ** 2 for r in X) / n) ** 0.5) for j in range(d)]
    Z = [[(r[j] - mu[j]) / sd[j] for j in range(d)] for r in X]
    w, b = [0.0] * d, 0.0
    for _ in range(epochs):
        gw, gb = [0.0] * d, 0.0
        for zi, yi in zip(Z, y):
            pr = 1.0 / (1.0 + math.exp(-(sum(w[j] * zi[j] for j in range(d)) + b)))
            e = pr - yi
            for j in range(d):
                gw[j] += e * zi[j]
            gb += e
        for j in range(d):
            w[j] -= lr * gw[j] / n
        b -= lr * gb / n
    return {"w": w, "b": b, "mu": mu, "sd": sd, "features": FEATURES}


def prob(model, p):
    z = [(v - m) / s for v, m, s in zip(featurise(p), model["mu"], model["sd"])]
    return 1.0 / (1.0 + math.exp(-(sum(a * b for a, b in zip(model["w"], z)) + model["b"])))


def evaluate(model, data, lab):
    """You WILL be asked for AUC and sensitivity. Returns a threshold table so you
    can answer whichever way the question is framed.

    Screening logic: tune for SENSITIVITY, accept low specificity. Missing a
    diabetic in a village you may not revisit for months costs far more than an
    unnecessary PHC referral. Published CBAC validation sits around 70-80%
    sensitivity / 50-60% specificity — being in that range is credible, and an
    implausibly high AUC on a 7-field checklist would invite more doubt, not less.
    """
    sc = [(prob(model, p), lab(p)) for p in data]
    pos = [s for s, y in sc if y == 1]
    neg = [s for s, y in sc if y == 0]
    if not pos or not neg:
        return None
    wins = sum(1.0 if a > b else 0.5 if a == b else 0.0 for a in pos for b in neg)
    auc = wins / (len(pos) * len(neg))

    table, youden = [], None
    for t in [i / 100 for i in range(2, 99)]:
        tp = sum(1 for s, y in sc if s >= t and y == 1)
        fn = sum(1 for s, y in sc if s < t and y == 1)
        fp = sum(1 for s, y in sc if s >= t and y == 0)
        tn = sum(1 for s, y in sc if s < t and y == 0)
        sens, spec = tp / max(1, tp + fn), tn / max(1, tn + fp)
        row = {"threshold": round(t, 2), "sensitivity": round(sens, 3),
               "specificity": round(spec, 3),
               "ppv": round(tp / max(1, tp + fp), 3),
               "referred_pct": round(100.0 * (tp + fp) / len(sc), 1),
               "tp": tp, "fp": fp, "fn": fn, "tn": tn}
        table.append(row)
        if youden is None or (sens + spec - 1) > (youden["sensitivity"] + youden["specificity"] - 1):
            youden = row

    def at_least(target):
        c = [r for r in table if r["sensitivity"] >= target]
        return max(c, key=lambda r: r["specificity"]) if c else None

    return {
        "auc": round(auc, 3),
        "prevalence": round(len(pos) / len(sc), 3),
        "n": len(sc),
        "youden_optimal": youden,
        "at_90pct_sensitivity": at_least(0.90),
        "at_80pct_sensitivity": at_least(0.80),
        "at_70pct_sensitivity": at_least(0.70),
    }


HUMAN = {"age": "Age", "waist_excess": "Waist above abdominal-obesity cut-off",
         "is_male": "Sex (male)", "family_hist_n": "Family history of diabetes",
         "tobacco_current": "Current tobacco use", "alcohol": "Alcohol use",
         "inactive": "Physical inactivity (<150 min/week)"}


def main():
    cohort = [make_patient(i) for i in range(N_COHORT)]
    X = [featurise(p) for p in cohort]
    dm = train_logreg(X, [1 if p["fbs"] >= 126 else 0 for p in cohort])
    htn = train_logreg(X, [1 if (p["sbp"] >= 140 or p["dbp"] >= 90) else 0 for p in cohort])

    dm_eval = evaluate(dm, cohort, lambda p: 1 if p["fbs"] >= 126 else 0)
    htn_eval = evaluate(htn, cohort, lambda p: 1 if (p["sbp"] >= 140 or p["dbp"] >= 90) else 0)

    # ---- sanity gate: every diabetes risk factor must push risk UP ----------
    # A model that produces a nonsensical explanation live is worse than no
    # explainability at all. Fail loudly here rather than on stage.
    bad = [f for f, w in zip(dm["features"], dm["w"])
           if w < 0 and f in ("age", "waist_excess", "family_hist_n", "tobacco_current", "inactive")]
    if bad:
        raise SystemExit(
            f"ABORT: implausible negative coefficient(s) for {bad}. "
            "The explainability panel would tell a judge these REDUCE diabetes risk. "
            "Fix the label generation before shipping.")

    WEIGHTS.parent.mkdir(parents=True, exist_ok=True)

    # ---- priority band cut-off --------------------------------------------
    # Shipped as an ABSOLUTE probability so the phone can band a patient offline
    # without knowing anything about the population. Derived as a percentile at
    # training time: the HIGH band is a capacity-sized priority slice, because
    # CBAC >=4 alone refers ~45% of adults and an ASHA cannot follow up 45%.
    probs = sorted(prob(dm, p) for p in cohort)
    hi_thr = round(probs[int(round(0.85 * (len(probs) - 1)))], 4)

    # Written through an explicit open() rather than Path.write_text() for two
    # reasons. newline="\n" defeats Windows' automatic \n -> \r\n translation, so
    # this file does not change byte-for-byte depending on whose laptop last ran
    # the build; and Path.write_text() only accepts a newline argument from Python
    # 3.10, while this project supports 3.8+. encoding is pinned because the
    # default is locale-dependent on Windows.
    with open(WEIGHTS, "w", encoding="utf-8", newline="\n") as f:
        json.dump(stable_floats({
            "diabetes": dm, "hypertension": htn, "human_readable": HUMAN,
            "eval": {"diabetes": dm_eval, "hypertension": htn_eval},
            "bands": {
                "high_dm_prob": hi_thr,
                "percentile": 85,
                "note": ("HIGH = a CBAC Part B red flag, or referred by the "
                         "deterministic rules AND diabetes risk at/above this "
                         "absolute probability (the 85th percentile of the training "
                         "cohort). Priority ordering inside the referral floor — it "
                         "never removes a referral the government rules require."),
            },
            "note": ("Synthetic cohort calibrated to published Indian NCD marginals. "
                     "Feature space == CBAC fields only. Deterministic CBAC/IDRS rules "
                     "form a referral floor the model cannot override."),
        }), f, indent=2)
        f.write("\n")

    import risk  # imported after weights exist
    risk._weights = None

    # ---- build DB ----------------------------------------------------------
    # Deleting the old file is the clean way, but it FAILS on Windows whenever
    # app.py still holds the DB open — and it will, because the natural workflow
    # is to leave the server running and re-bootstrap in another terminal. So:
    # try to delete, and if the OS says no, drop the tables in place instead.
    # Same end state, no "close your other terminal first" step at 2am.
    if DB.exists():
        try:
            DB.unlink()
        except OSError as e:
            print(f"  (cannot delete {DB.name}: {e.strerror} — dropping tables in place)")
            with sqlite3.connect(DB) as _c:
                _c.executescript("""
                DROP TABLE IF EXISTS screenings;
                DROP TABLE IF EXISTS patients;
                """)
                _c.commit()
    con = sqlite3.connect(DB)
    con.executescript("""
    CREATE TABLE patients(
      patient_id TEXT PRIMARY KEY, name TEXT, sex TEXT, age INT,
      village TEXT, lat REAL, lon REAL, is_synthetic INT DEFAULT 1);
    CREATE TABLE screenings(
      id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT, screened_on TEXT,
      waist_cm REAL, activity_level TEXT, active_minutes_week INT,
      parents_with_diabetes INT, family_history INT, tobacco TEXT, alcohol INT,
      sbp INT, dbp INT, fbs INT, part_b TEXT,
      cbac_score INT, idrs_score INT, ml_diabetes_risk REAL,
      ml_hypertension_risk REAL, risk_band TEXT, refer INT,
      referral_reasons TEXT, top_drivers TEXT,
      synced_at TEXT, client_uuid TEXT UNIQUE, is_synthetic INT DEFAULT 1);
    CREATE INDEX idx_scr_pat ON screenings(patient_id);
    CREATE INDEX idx_scr_date ON screenings(screened_on);
    """)

    today = date(2026, 8, 25)

    def insert_screening(p, when, tag=None):
        a = risk.assess(p)
        con.execute("""INSERT INTO screenings(patient_id,screened_on,waist_cm,
            activity_level,active_minutes_week,parents_with_diabetes,family_history,
            tobacco,alcohol,sbp,dbp,fbs,part_b,cbac_score,idrs_score,
            ml_diabetes_risk,ml_hypertension_risk,risk_band,refer,referral_reasons,
            top_drivers,synced_at,client_uuid)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
            p["patient_id"], when.isoformat(), p["waist_cm"], p["activity_level"],
            p["active_minutes_week"], p["parents_with_diabetes"],
            int(p["family_history"]), p["tobacco"], int(p["alcohol"]),
            p["sbp"], p["dbp"], p["fbs"],
            json.dumps([k for k in PART_B if p.get(k)]),
            a["cbac_score"], a["idrs_score"], a["ml_diabetes_risk"],
            a["ml_hypertension_risk"], a["risk_band"], int(a["refer"]),
            json.dumps(a["referral_reasons"]), json.dumps(a["top_drivers"]),
            when.isoformat(), f"seed-{p['patient_id']}-{when.isoformat()}-{tag or 0}"))
        return a

    for p in cohort:
        con.execute("INSERT INTO patients VALUES(?,?,?,?,?,?,?,1)",
                    (p["patient_id"], p["name"], p["sex"], p["age"],
                     p["village"], p["lat"], p["lon"]))
        insert_screening(p, today - timedelta(days=random.randint(1, 30)))

    # ---- trend patients ----------------------------------------------------
    # Cheap, and it delivers on the deck's "continuous remote monitoring" claim:
    # 3 patients get 6 monthly visits with steadily worsening measurements, so the
    # trend chart and the deterioration alert are real rather than mocked.
    trend_ids = []
    for p in sorted(cohort, key=lambda q: -q["fbs"])[:3]:
        trend_ids.append(p["patient_id"])
        con.execute("DELETE FROM screenings WHERE patient_id=?", (p["patient_id"],))
        for k in range(6, -1, -1):
            q = dict(p)
            drift = (6 - k)
            q["fbs"] = max(70, int(p["fbs"] - 5.5 * k))
            q["sbp"] = max(95, int(p["sbp"] - 2.6 * k))
            q["waist_cm"] = round(max(62.0, p["waist_cm"] - 0.9 * k), 1)
            insert_screening(q, today - timedelta(days=30 * k + 1), tag=f"t{drift}")

    con.commit()

    with open(ROOT / "server" / "cohort.csv", "w", newline="") as f:
        wr = csv.DictWriter(f, fieldnames=list(cohort[0].keys()))
        wr.writeheader()
        wr.writerows(cohort)

    n_pat = con.execute("SELECT COUNT(*) FROM patients").fetchone()[0]
    n_scr = con.execute("SELECT COUNT(*) FROM screenings").fetchone()[0]
    print(f"DB built: {n_pat} patients, {n_scr} screenings -> {DB}")
    print(f"Weights : {WEIGHTS}")
    print(f"Diabetes     AUC {dm_eval['auc']}  prev {dm_eval['prevalence']}")
    for k in ('youden_optimal','at_90pct_sensitivity','at_80pct_sensitivity','at_70pct_sensitivity'):
        r=dm_eval[k]
        if r: print(f"   {k:<24} thr {r['threshold']:<5} sens {r['sensitivity']:<6} spec {r['specificity']:<6} PPV {r['ppv']:<6} refers {r['referred_pct']}%")
    print(f"Hypertension AUC {htn_eval['auc']}")
    print("Coefficient signs (diabetes):")
    for f, w in zip(dm["features"], dm["w"]):
        print(f"   {f:<18}{w:+.3f}")
    print("Trend-demo patients (use these on stage):", ", ".join(trend_ids))
    print("\nVillage risk (heatmap ordering):")
    for v, n, h in con.execute("""
        SELECT p.village, COUNT(*), SUM(s.risk_band='HIGH')
        FROM patients p JOIN screenings s ON s.patient_id=p.patient_id
        GROUP BY p.village
        ORDER BY SUM(s.risk_band='HIGH')*1.0/COUNT(*) DESC"""):
        print(f"   {v:<20}{n:>5} screenings{h:>5} high  {100*h/n:>5.1f}%")
    con.close()


if __name__ == "__main__":
    main()

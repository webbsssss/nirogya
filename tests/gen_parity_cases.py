"""Emit patients + Python-computed assessments for tests/parity_test.js.

  python3 tests/gen_parity_cases.py > tests/parity_cases.json

Includes deliberate BOUNDARY cases (waist exactly 80/90/100, age exactly
35/40/50/60, activity exactly 150 min) because that is precisely where a
JS/Python port diverges — an off-by-one in a `<` vs `<=` would otherwise only
show up when a judge types a round number into the form on stage.
"""
import itertools
import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import risk  # noqa: E402


def boundary_cases():
    """Cartesian product over every threshold in CBAC and IDRS."""
    cases = []
    for age, waist, sex, mins, parents, tob, alc in itertools.product(
        [30, 34, 35, 39, 40, 49, 50, 59, 60, 78],      # CBAC + IDRS age cuts
        [79.0, 80.0, 89.0, 90.0, 99.0, 100.0, 101.0],  # both sexes' waist cuts
        ["M", "F"],
        [149, 150, 151],                                # WHO activity cut
        [0, 1, 2],
        ["never", "former", "current"],
        [True, False],
    ):
        cases.append({
            "age": age, "sex": sex, "waist_cm": waist,
            "active_minutes_week": mins,
            "activity_level": ("sedentary" if mins < 100 else
                               "mild" if mins < 150 else "moderate"),
            "parents_with_diabetes": parents,
            "family_history": parents > 0,
            "tobacco": tob, "alcohol": alc,
        })
    # full product is ~25k; sample deterministically to keep the run fast
    random.Random(11).shuffle(cases)
    return cases[:1500]


def random_cases(n=600):
    """Realistic patients, via the same generator the demo cohort uses."""
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "bs", Path(__file__).resolve().parent.parent / "server" / "bootstrap.py")
    bs = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bs)
    random.seed(123)
    out = []
    for i in range(n):
        p = bs.make_patient(i)
        out.append({k: p[k] for k in (
            "age", "sex", "waist_cm", "active_minutes_week", "activity_level",
            "parents_with_diabetes", "family_history", "tobacco", "alcohol",
            *risk.CBAC_PART_B)})
    return out


def main():
    cases = boundary_cases() + random_cases()
    W = risk.weights()
    out = []
    for p in cases:
        a = risk.assess(p)
        dm_raw, _ = risk.predict(W["diabetes"], p)
        htn_raw, _ = risk.predict(W["hypertension"], p)
        a["_raw_dm"] = dm_raw
        a["_raw_htn"] = htn_raw
        out.append({"patient": p, "expected": a})
    json.dump({"n": len(out), "cases": out}, sys.stdout)


if __name__ == "__main__":
    main()

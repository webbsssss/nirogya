"""Plausibility check: does the synthetic cohort resemble published Indian rural
NCD epidemiology? Run after bootstrap.py.

If these drift far from the target bands, a judge can reasonably say the demo
data is not credible.

  NIROGYA_DB=/path/to.db python3 server/check_cohort.py

NOTE ON THE REFERRAL BAND (read this before "fixing" it):
The original band here was 25-45% and the cohort kept coming in above it. The
band was wrong, not the data. CBAC is deliberately age-weighted -- age alone
contributes up to 3 of the 4 points needed -- so CBAC >=4 genuinely fires for
~45% of adults 30+. That is a well-documented criticism of the instrument (high
sensitivity, low specificity), not a bug in this generator. Do NOT tune the
cohort to hide it. It is the entire reason Nirogya has a value proposition:
see the PRIORITISATION section at the bottom.
"""
import os
import sqlite3
from pathlib import Path

DB = Path(os.environ.get("NIROGYA_DB") or (Path(__file__).resolve().parent / "nirogya.db"))
c = sqlite3.connect(DB)
q = lambda s: c.execute(s).fetchone()[0]

scr = q("SELECT COUNT(*) FROM screenings")
pat = q("SELECT COUNT(*) FROM patients")

CHECKS = [
    ("HIGH risk band", "SELECT COUNT(*) FROM screenings WHERE risk_band='HIGH'", 10, 28,
     "must be a caseload one ASHA can actually work through"),
    ("Referred (any reason)", "SELECT COUNT(*) FROM screenings WHERE refer=1", 35, 58,
     "CBAC >=4 alone fires ~45% -- see the note at the top of this file"),
    ("Diabetes (FBS>=126)", "SELECT COUNT(*) FROM screenings WHERE fbs>=126", 8, 18,
     "ICMR-INDIAB rural diabetes ~11-12%"),
    ("Prediabetes (100-125)", "SELECT COUNT(*) FROM screenings WHERE fbs>=100 AND fbs<126", 12, 30,
     "ICMR-INDIAB: prediabetes (136M) exceeds diabetes (101M), ratio ~1.35"),
    ("Hypertension (>=140/90)", "SELECT COUNT(*) FROM screenings WHERE sbp>=140 OR dbp>=90", 15, 32,
     "NFHS-5 rural hypertension"),
    ("Current tobacco", "SELECT COUNT(*) FROM screenings WHERE tobacco='current'", 8, 25,
     "GATS-2 rural tobacco use, any form incl. smokeless"),
    ("Physically inactive", "SELECT COUNT(*) FROM screenings WHERE active_minutes_week<150", 25, 55,
     "ICMR-INDIAB/Anjana: ~50% of Indians below WHO 150 min/wk"),
    ("Any CBAC Part B flag", "SELECT COUNT(*) FROM screenings WHERE part_b!='[]'", 3, 12,
     "TB/COPD/cancer red flags are individually rare; 19% was implausible"),
]

print(f"DB {DB.name}   {pat} patients / {scr} screenings\n")
print(f"{'indicator':<26}{'actual':>8}{'target':>14}   status")
print("-" * 70)
ok = True
for label, sql, lo, hi, why in CHECKS:
    pct = 100.0 * q(sql) / scr
    good = lo <= pct <= hi
    ok &= good
    print(f"{label:<26}{pct:>7.1f}%{f'{lo}-{hi}%':>14}   {'ok' if good else 'OUT OF RANGE'}")
    if not good:
        print(f"{'':<26}   ^ benchmark: {why}")

print("\nMean waist by sex (abdominal obesity cut-offs: M 90cm, F 80cm)")
for sex, lab in (("M", "male"), ("F", "female")):
    r = c.execute("""SELECT ROUND(AVG(s.waist_cm),1), ROUND(100.0*SUM(
                       CASE WHEN (p.sex='M' AND s.waist_cm>=90)
                                 OR (p.sex='F' AND s.waist_cm>=80)
                            THEN 1 ELSE 0 END)/COUNT(*),1)
                     FROM screenings s JOIN patients p USING(patient_id)
                     WHERE p.sex=?""", (sex,)).fetchone()
    print(f"  {lab:<8} mean {r[0]} cm   above cut-off {r[1]}%")

print("\nDiabetes rate by risk factor (every gradient MUST run the right way --")
print("this is what keeps the learned coefficients epidemiologically sensible)")
GRADIENTS = [
    ("current tobacco", "s.tobacco='current'"),
    ("inactive <150min", "s.active_minutes_week<150"),
    ("family history", "s.parents_with_diabetes>0"),
    ("waist above cut-off", "(p.sex='M' AND s.waist_cm>=90) OR (p.sex='F' AND s.waist_cm>=80)"),
    ("age >= 50", "p.age>=50"),
]
grad_ok = True
for label, cond in GRADIENTS:
    r = c.execute(f"""SELECT
        ROUND(100.0*AVG(CASE WHEN ({cond}) AND s.fbs>=126 THEN 1.0
                             WHEN ({cond}) THEN 0.0 END),1),
        ROUND(100.0*AVG(CASE WHEN NOT ({cond}) AND s.fbs>=126 THEN 1.0
                             WHEN NOT ({cond}) THEN 0.0 END),1),
        SUM(CASE WHEN ({cond}) THEN 1 ELSE 0 END)
        FROM screenings s JOIN patients p USING(patient_id)""").fetchone()
    with_, without, n = r
    good = (with_ or 0) > (without or 0)
    grad_ok &= good
    print(f"  {label:<22} n={n:<5} {with_:>5}%  vs  {without:>5}%   "
          f"{'ok' if good else 'WRONG DIRECTION'}")
ok &= grad_ok

print("\nVillage spread (need real separation for the heatmap to mean anything)")
rows = c.execute("""SELECT p.village, COUNT(*),
                      ROUND(100.0*SUM(s.risk_band='HIGH')/COUNT(*),1)
                    FROM patients p JOIN screenings s USING(patient_id)
                    GROUP BY p.village
                    ORDER BY 3 DESC""").fetchall()
for v, n, h in rows:
    print(f"  {v:<20}{n:>5}  {h:>5}%  {'#' * int(h / 2)}")
spread = rows[0][2] - rows[-1][2]
spread_ok = spread >= 15
ok &= spread_ok
print(f"\n  spread top-to-bottom: {spread:.1f} pts  "
      f"({'ok, hotspot is visible' if spread_ok else 'TOO FLAT - heatmap will look like noise'})")

# ---------------------------------------------------------------------------
# The pitch point that fell out of the calibration work. Say this to judges.
# ---------------------------------------------------------------------------
cbac_refer = 100.0 * q("SELECT COUNT(*) FROM screenings WHERE cbac_score>=4") / scr
high = 100.0 * q("SELECT COUNT(*) FROM screenings WHERE risk_band='HIGH'") / scr
print(f"""
PRIORITISATION -- this is the argument, not a defect
  CBAC >=4 alone refers ................ {cbac_refer:.1f}% of everyone screened
  Nirogya HIGH band ................... {high:.1f}%
  A PHC cannot absorb {cbac_refer:.0f}% of the adult population. Nirogya does not
  shrink that referral floor -- by design it CANNOT, the deterministic rules can
  only escalate. What it adds is an ordering INSIDE the floor, so the ASHA works
  the top {high:.0f}% first instead of a {cbac_refer:.0f}% list with no priority at all.""")

print("\n" + ("ALL CHECKS PASSED" if ok else "SOME CHECKS OUT OF RANGE - retune bootstrap.py"))

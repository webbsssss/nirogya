"""
Nirogya API + static server. Python standard library ONLY — no pip install.

  python3 server/bootstrap.py    # once: generate cohort, train, build DB
  python3 server/app.py          # then: serve on http://0.0.0.0:8000

Serves the PWA from the SAME origin as the API, so there is no CORS to debug at
8pm on Thursday. Bind is 0.0.0.0 so a judge's phone on the same Wi-Fi (or your
laptop hotspot) can open it — print the LAN URL and QR-able link on startup.

Endpoints
  GET  /api/health
  GET  /api/model                     model weights for OFFLINE on-device scoring
  GET  /api/patients?village=&band=&refer=1&q=
  GET  /api/patients/<id>             patient + full screening history (trend)
  POST /api/screen                    score + persist one screening
  POST /api/sync                      batch upload from the offline queue (idempotent)
  GET  /api/villages                  village aggregation for the heatmap
  GET  /api/stats                     headline counters
"""

import json
import os
import socket
import sqlite3
import sys
from datetime import date
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, unquote

sys.path.insert(0, str(Path(__file__).resolve().parent))
import risk  # noqa: E402
import validate  # noqa: E402
from validate import Invalid  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
DB = Path(os.environ.get("NIROGYA_DB") or (ROOT / "server" / "nirogya.db"))
PORT = int(os.environ.get("PORT", "8000"))

PART_B = risk.CBAC_PART_B

# Largest request body accepted, in bytes. A queued batch of 500 screenings is
# roughly 250 KB, so 1 MB is generous. Without a ceiling, `self.rfile.read(n)`
# with an attacker-chosen Content-Length is an invitation to allocate the
# machine's memory from a single request.
MAX_BODY = 1_048_576

# Content Security Policy. Worth stating plainly because it is unusually strict
# and that is only possible because of a design decision: the app loads NOTHING
# from a third party. No CDN, no font service, no analytics. So the policy can be
# 'self' almost throughout, with two deliberate exceptions:
#
#   style-src 'unsafe-inline'  - the screens set geometry with style="width:42%"
#       attributes (the driver bars, the heatmap tracks). Attribute styles cannot
#       execute script; this is the weakest clause here and it costs nothing.
#   img-src data:              - allows an inline SVG/PNG data URI if one is ever
#       added for an icon. Images do not execute.
#
# script-src has NO 'unsafe-inline'. That is the clause that matters, and it is
# why web/js/sw-register.js exists as a file rather than an inline <script> in
# index.html: with it in force, an injected <script> tag or an onerror= attribute
# cannot run even if a markup sink were ever reintroduced into the app. It is a
# second, independent layer under h()'s createTextNode.
#
# Deliberately NOT set: Permissions-Policy. The obvious value would disable the
# camera and geolocation, but the microphone has to stay allowed for Kannada voice
# input and getting that clause subtly wrong would break the single most fragile
# feature in the demo for no security gain.
CSP = "; ".join((
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
))


def db():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    return con


def _reject_constant(name):
    """json.loads calls this for the bare literals NaN, Infinity and -Infinity,
    which it otherwise accepts even though JSON does not define them."""
    raise Invalid([{"field": "_body", "message": f"{name} is not a valid JSON value"}])


def row_to_patient(r):
    """Rebuild the dict shape risk.assess() expects from a screenings row."""
    return {
        "age": r["age"], "sex": r["sex"], "waist_cm": r["waist_cm"],
        "activity_level": r["activity_level"],
        "active_minutes_week": r["active_minutes_week"],
        "parents_with_diabetes": r["parents_with_diabetes"],
        "family_history": bool(r["family_history"]),
        "tobacco": r["tobacco"], "alcohol": bool(r["alcohol"]),
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(WEB), **kw)

    # ---- plumbing --------------------------------------------------------
    def log_message(self, fmt, *args):
        if "/api/" in (self.path or ""):
            sys.stderr.write("  %s %s\n" % (self.command, self.path))

    def _send(self, obj, code=200):
        body = json.dumps(obj, default=str, allow_nan=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _fail(self, code, message, fields=None):
        """The ONLY way an error leaves this server.

        It used to be `self._send({"error": f"{type(e).__name__}: {e}"}, 500)`,
        which handed the client the Python exception class and message verbatim.
        That is genuinely useful while building and genuinely wrong to ship: a
        stranger on the venue Wi-Fi could learn we run sqlite3, which columns
        exist, and where the tree lives on disk, one malformed request at a time.

        So: the detail goes to stderr where we can read it, and the client gets a
        stable message plus — for a validation failure only — the field list,
        which is information the client supplied in the first place and needs back
        in order to fix the record.
        """
        out = {"error": message}
        if fields:
            out["fields"] = fields
        self._send(out, code)

    def _body(self):
        """Read and parse a JSON request body, with a ceiling and no surprises.

        Every failure in here used to be a 500 with a leaked exception:
        Content-Length: abc, a truncated body, or {"age": ...} with a trailing
        comma. They are all the client's mistake and all deserve a 400.
        """
        raw_len = self.headers.get("Content-Length")
        try:
            n = int(raw_len or 0)
        except ValueError:
            raise Invalid([{"field": "_body", "message": "Content-Length is not a number"}])
        if n < 0:
            raise Invalid([{"field": "_body", "message": "Content-Length is negative"}])
        if n > MAX_BODY:
            raise Invalid([{"field": "_body",
                            "message": f"body is {n} bytes, over the {MAX_BODY}-byte limit"}])
        raw = self.rfile.read(n) if n else b""
        if not raw.strip():
            return {}
        try:
            # parse_constant rejects the bare literals NaN, Infinity and
            # -Infinity, which json.loads accepts by DEFAULT even though they are
            # not valid JSON. A NaN that reaches risk.py scores as the oldest age
            # band with every comparison false, and then json.dumps writes `NaN`
            # into the response — which the app's JSON.parse cannot read, so the
            # ASHA sees an unexplained failure. Refuse it at the boundary.
            return json.loads(raw.decode("utf-8"),
                              parse_constant=_reject_constant)
        except UnicodeDecodeError:
            raise Invalid([{"field": "_body", "message": "body is not valid UTF-8"}])
        except json.JSONDecodeError as e:
            raise Invalid([{"field": "_body", "message": f"body is not valid JSON (line {e.lineno}, column {e.colno})"}])

    # do_OPTIONS and Access-Control-Allow-Origin: * are BOTH deliberately gone.
    #
    # The PWA is served from the same origin as the API — that is the whole reason
    # app.py serves web/ itself — so no browser ever sends a preflight and the
    # header was never needed. What it did do was tell every browser that any
    # website on the internet may read this API and POST screenings to it. On a
    # laptop on shared venue Wi-Fi that is a real exposure for one line of
    # convenience that nothing used.

    def list_directory(self, path):
        """No directory indexes.

        SimpleHTTPRequestHandler generates a browsable listing for any directory
        without an index.html, so /js/ and /data/ handed out a complete file
        inventory of the app. Nothing legitimate requests a directory here.
        """
        self.send_error(404, "Not Found")
        return None

    def end_headers(self):
        # Security headers in ONE place, so no response can be missed. See CSP
        # above for why the policy can be this strict.
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        # never let the service worker or app shell go stale mid-demo
        if (self.path or "").endswith(("sw.js", ".webmanifest")):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    # ---- routing ---------------------------------------------------------
    def do_GET(self):
        p = self.path.split("?")[0]
        if not p.startswith("/api/"):
            return super().do_GET()
        try:
            if p == "/api/health":
                return self._send({"ok": True, "db": DB.name, "today": date.today().isoformat()})
            if p == "/api/model":
                return self._send(risk.weights())
            if p == "/api/villages":
                return self._send(self.villages())
            if p == "/api/stats":
                return self._send(self.stats())
            if p == "/api/patients":
                return self._send(self.patients())
            if p.startswith("/api/patients/"):
                pid = validate.clean_patient_id(unquote(p[len("/api/patients/"):]))
                found = self.patient(pid)
                return self._send(found, 200 if found.get("patient") else 404)
            self._fail(404, "not found")
        except Invalid as e:
            self._fail(400, "invalid request", e.fields)
        except Exception as e:  # keep the demo alive; log for us, not for them
            sys.stderr.write(f"  !! GET {self.path}: {type(e).__name__}: {e}\n")
            self._fail(500, "internal error — see server log")

    def do_POST(self):
        p = self.path.split("?")[0]
        try:
            if p == "/api/screen":
                return self._send(self.screen(self._body()))
            if p == "/api/sync":
                return self._send(self.sync(self._body()))
            self._fail(404, "not found")
        except Invalid as e:
            # 400, not 500 and certainly not 200. A rejected screening used to
            # come back as HTTP 200 with {"error": ...} in the body, so a client
            # checking r.ok saw a success and moved on.
            self._fail(400, "invalid screening", e.fields)
        except Exception as e:
            sys.stderr.write(f"  !! POST {self.path}: {type(e).__name__}: {e}\n")
            self._fail(500, "internal error — see server log")

    # ---- query params ----------------------------------------------------
    def qp(self):
        if "?" not in self.path:
            return {}
        return {k: unquote(v[0]) for k, v in parse_qs(self.path.split("?", 1)[1]).items()}

    # ---- handlers --------------------------------------------------------
    def patients(self):
        q = validate.clean_query(self.qp())
        sql = """
        SELECT p.patient_id,p.name,p.sex,p.age,p.village,p.lat,p.lon,
               s.screened_on,s.cbac_score,s.idrs_score,s.ml_diabetes_risk,
               s.ml_hypertension_risk,s.risk_band,s.refer,s.referral_reasons,
               s.top_drivers,s.sbp,s.dbp,s.fbs,s.waist_cm
        FROM patients p
        JOIN screenings s ON s.id = (
            SELECT id FROM screenings WHERE patient_id=p.patient_id
            ORDER BY screened_on DESC, id DESC LIMIT 1)
        WHERE 1=1"""
        args = []
        if q.get("village"):
            sql += " AND p.village=?"; args.append(q["village"])
        if q.get("band"):
            sql += " AND s.risk_band=?"; args.append(q["band"])
        if q.get("refer"):
            sql += " AND s.refer=1"
        if q.get("q"):
            # LIKE wildcards in the search term are escaped, so a name containing
            # % or _ searches for that character instead of matching everything.
            term = q["q"].replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            sql += " AND (p.name LIKE ? ESCAPE '\\' OR p.patient_id LIKE ? ESCAPE '\\')"
            args += [f"%{term}%"] * 2
        # highest risk first — this IS the ASHA worker's work queue
        sql += """ ORDER BY CASE s.risk_band WHEN 'HIGH' THEN 0
                   WHEN 'MODERATE' THEN 1 ELSE 2 END,
                   s.ml_diabetes_risk DESC LIMIT ?"""
        args.append(q["limit"])

        with db() as con:
            out = []
            for r in con.execute(sql, args):
                d = dict(r)
                d["referral_reasons"] = json.loads(d["referral_reasons"] or "[]")
                d["top_drivers"] = json.loads(d["top_drivers"] or "[]")
                d["refer"] = bool(d["refer"])
                d["is_synthetic"] = True
                out.append(d)
        return {"count": len(out), "patients": out, "is_synthetic": True}

    def patient(self, pid):
        with db() as con:
            pr = con.execute("SELECT * FROM patients WHERE patient_id=?", (pid,)).fetchone()
            if not pr:
                # Shape-compatible with the success case so the caller can read
                # .patient to decide the status code, and so the app never has to
                # branch on which of two different response shapes it received.
                return {"patient": None, "history": [], "alerts": [],
                        "error": "no such patient", "is_synthetic": True}
            hist = []
            for r in con.execute("""SELECT * FROM screenings WHERE patient_id=?
                                    ORDER BY screened_on ASC, id ASC""", (pid,)):
                d = dict(r)
                d["referral_reasons"] = json.loads(d["referral_reasons"] or "[]")
                d["top_drivers"] = json.loads(d["top_drivers"] or "[]")
                d["part_b"] = json.loads(d["part_b"] or "[]")
                d["refer"] = bool(d["refer"])
                hist.append(d)

        # ---- deterioration detection (the deck's "continuous monitoring") ----
        # Deliberately simple and explainable: compare the mean of the earliest
        # visits against the latest. A judge can follow this in one sentence; an
        # ARIMA model would be harder to defend and no more convincing here.
        #
        # The BASELINE IS THE MEAN OF THE FIRST TWO VISITS, not the first visit.
        # That is on purpose -- one unusually high or low opening reading should
        # not manufacture or mask an alert. But it means the delta will NOT equal
        # (last - first), which is the subtraction anyone looking at the visit
        # table will actually do. So the message states the baseline explicitly
        # and the UI shows it. Saying only "rose 30.5 across 7 visits" next to a
        # table reading 177 -> 210 looks like a bug and invites exactly the
        # question you do not want mid-demo.
        alerts = []
        if len(hist) >= 3:
            for field, label, unit, thresh in [
                ("fbs", "Fasting blood sugar", "mg/dL", 12),
                ("sbp", "Systolic BP", "mmHg", 8),
                ("waist_cm", "Waist circumference", "cm", 3),
            ]:
                vals = [h[field] for h in hist if h[field] is not None]
                if len(vals) >= 3:
                    base = sum(vals[:2]) / 2.0
                    now = vals[-1]
                    if now - base >= thresh:
                        alerts.append({
                            "field": field, "label": label, "unit": unit,
                            "from": round(base, 1), "to": round(now, 1),
                            "delta": round(now - base, 1),
                            "baseline_visits": 2,
                            "baseline_note": "baseline = mean of first 2 visits",
                            "first_value": vals[0], "n_visits": len(vals),
                            "message": (
                                f"{label} +{round(now-base,1)} {unit} "
                                f"(baseline {round(base,1)}, mean of first 2 visits "
                                f"→ {round(now,1)} latest, across {len(vals)} visits). "
                                f"Escalate to PHC."),
                        })
        return {"patient": dict(pr), "history": hist, "alerts": alerts,
                "is_synthetic": True}

    @staticmethod
    def _new_patient_id(con):
        """Allocate a patient id that is not already taken.

        The previous version was a bare f-string with 2 random bytes and no
        existence check. 65 536 values per day sounds like plenty until you write
        out what a collision actually does: `INSERT OR IGNORE INTO patients` is
        ignored, and the new screening is silently filed under a DIFFERENT
        person's record. That is the worst single failure this app can have, so it
        is 4 bytes and a lookup now.
        """
        for _ in range(20):
            pid = f"NRG{int(date.today().strftime('%j'))}{os.urandom(4).hex()}"
            if not con.execute("SELECT 1 FROM patients WHERE patient_id=?", (pid,)).fetchone():
                return pid
        raise RuntimeError("could not allocate an unused patient_id in 20 attempts")

    def screen(self, raw_payload):
        """Score a screening and persist it. Returns the full assessment so the
        app can show the explainability panel immediately.

        Raises validate.Invalid on bad input — the caller turns that into a 400.
        Nothing reaches risk.assess() or SQLite that has not been through
        clean_screening() first.
        """
        p = validate.clean_screening(raw_payload)
        a = risk.assess(p)
        when = p["screened_on"]

        with db() as con:
            pid = p["patient_id"] or self._new_patient_id(con)
            # The SCREENING goes in first, and the patient row only if it landed.
            # Reversing these two leaves an orphan patient with no screenings
            # whenever client_uuid collides, and an orphan is invisible to the
            # roster (it is an inner join) but permanent in the table.
            cur = con.execute("""INSERT OR IGNORE INTO screenings(patient_id,screened_on,
                waist_cm,activity_level,active_minutes_week,parents_with_diabetes,
                family_history,tobacco,alcohol,sbp,dbp,fbs,part_b,cbac_score,
                idrs_score,ml_diabetes_risk,ml_hypertension_risk,risk_band,refer,
                referral_reasons,top_drivers,synced_at,client_uuid)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
                pid, when, p["waist_cm"], p["activity_level"],
                p["active_minutes_week"], p["parents_with_diabetes"],
                int(p["family_history"]), p["tobacco"],
                int(p["alcohol"]), p["sbp"], p["dbp"],
                p["fbs"], json.dumps([k for k in PART_B if p.get(k)]),
                a["cbac_score"], a["idrs_score"], a["ml_diabetes_risk"],
                a["ml_hypertension_risk"], a["risk_band"], int(a["refer"]),
                json.dumps(a["referral_reasons"]), json.dumps(a["top_drivers"]),
                date.today().isoformat(), p["client_uuid"]))
            stored = cur.rowcount > 0
            if stored:
                con.execute("""INSERT OR IGNORE INTO patients
                    (patient_id,name,sex,age,village,lat,lon,is_synthetic)
                    VALUES(?,?,?,?,?,?,?,1)""", (
                    pid, p["name"], p["sex"], p["age"],
                    p["village"], p["lat"], p["lon"]))
            con.commit()
        return {"patient_id": pid, "assessment": a, "stored": stored,
                "is_synthetic": True}

    def sync(self, payload):
        """Batch upload of the offline queue.

        IDEMPOTENT via client_uuid UNIQUE + INSERT OR IGNORE. This matters on
        stage: pressing Sync twice, or a flaky reconnect, must not duplicate
        records. A judge may well press it twice on purpose.

        EVERY ITEM IS ISOLATED. This is the fix for the worst defect the platform
        had, and it is worth spelling out because the failure was invisible rather
        than dramatic. There was no try/except in this loop, so a single malformed
        queued record — one bad enum was enough — raised out of self.screen(),
        out of do_POST, and returned HTTP 500 for the WHOLE BATCH. The valid
        records in that batch were already committed, but the 500 carried no
        `applied` list, so syncNow() threw before parsing, db.dequeue() never ran,
        and the queue kept every record it had just successfully uploaded. The
        pending badge then stayed lit forever, the ASHA re-synced, and every retry
        failed identically on the same bad item. One bad record could freeze the
        sync of an entire phone, and nothing on either side said why.

        So the contract is now: the batch ALWAYS returns 200 with a per-item
        verdict, and a bad item can only ever fail itself.

          applied            - stored now
          duplicates_ignored - already had it; safe for the client to drop
          errors[].permanent - true: retrying cannot help, the record needs a
                               human. false: transient, keep it queued.
        """
        if not isinstance(payload, dict):
            raise Invalid([{"field": "_body", "message": "expected a JSON object"}])
        items = payload.get("screenings")
        if items is None:
            items = []
        if not isinstance(items, list):
            raise Invalid([{"field": "screenings",
                            "message": f"expected a list, got {type(items).__name__}"}])
        if len(items) > validate.MAX_BATCH:
            raise Invalid([{"field": "screenings",
                            "message": f"{len(items)} items, over the {validate.MAX_BATCH} limit"}])

        applied, skipped, errors = [], [], []
        for i, it in enumerate(items):
            cid = it.get("client_uuid") if isinstance(it, dict) else None
            if not isinstance(cid, str) or not cid.strip():
                cid = None
            try:
                if not isinstance(it, dict):
                    raise Invalid([{"field": "_item",
                                    "message": f"expected a JSON object, got {type(it).__name__}"}])
                if cid is None:
                    raise Invalid([{"field": "client_uuid",
                                    "message": "is required — it is what makes sync idempotent"}])
                with db() as con:
                    seen = con.execute("SELECT 1 FROM screenings WHERE client_uuid=?",
                                       (cid,)).fetchone()
                if seen:
                    skipped.append(cid)
                    continue
                r = self.screen(it)
                if r["stored"]:
                    applied.append({"client_uuid": cid,
                                    "patient_id": r["patient_id"],
                                    "risk_band": r["assessment"]["risk_band"]})
                else:
                    # Lost a race with a concurrent sync of the same uuid. The
                    # record is in the database either way, which is all the
                    # client needs to know to stop holding it.
                    skipped.append(cid)
            except Invalid as e:
                errors.append({"index": i, "client_uuid": cid, "permanent": True,
                               "message": "this record cannot be accepted as it stands",
                               "fields": e.fields})
            except Exception as e:
                sys.stderr.write(f"  !! sync item {i} ({cid}): {type(e).__name__}: {e}\n")
                errors.append({"index": i, "client_uuid": cid, "permanent": False,
                               "message": "server error — the record is still queued and will retry"})
        return {"received": len(items), "applied": applied,
                "duplicates_ignored": skipped, "errors": errors,
                "synced_at": date.today().isoformat()}

    def villages(self):
        with db() as con:
            rows = con.execute("""
            SELECT p.village AS village, AVG(p.lat) AS lat, AVG(p.lon) AS lon,
                   COUNT(*) AS screened,
                   SUM(s.risk_band='HIGH') AS high,
                   SUM(s.risk_band='MODERATE') AS moderate,
                   SUM(s.refer) AS referred,
                   AVG(s.ml_diabetes_risk) AS mean_dm_risk,
                   AVG(s.cbac_score) AS mean_cbac
            FROM patients p
            JOIN screenings s ON s.id = (
                SELECT id FROM screenings WHERE patient_id=p.patient_id
                ORDER BY screened_on DESC, id DESC LIMIT 1)
            GROUP BY p.village""").fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["high_pct"] = round(100.0 * d["high"] / max(1, d["screened"]), 1)
            d["refer_pct"] = round(100.0 * d["referred"] / max(1, d["screened"]), 1)
            d["mean_dm_risk"] = round(d["mean_dm_risk"] or 0, 4)
            d["mean_cbac"] = round(d["mean_cbac"] or 0, 2)
            out.append(d)
        out.sort(key=lambda x: -x["high_pct"])
        # the whole point of the dashboard: one clear operational recommendation
        return {"villages": out, "is_synthetic": True,
                "recommended_camp": out[0]["village"] if out else None}

    def stats(self):
        with db() as con:
            q = lambda s: con.execute(s).fetchone()[0]
            return {
                "patients": q("SELECT COUNT(*) FROM patients"),
                "screenings": q("SELECT COUNT(*) FROM screenings"),
                "high_risk": q("SELECT COUNT(*) FROM screenings WHERE risk_band='HIGH'"),
                "referred": q("SELECT COUNT(*) FROM screenings WHERE refer=1"),
                "villages": q("SELECT COUNT(DISTINCT village) FROM patients"),
                "model": {
                    "diabetes_auc": risk.weights()["eval"]["diabetes"]["auc"],
                    "hypertension_auc": risk.weights()["eval"]["hypertension"]["auc"],
                    "operating_point": risk.weights()["eval"]["diabetes"]["at_80pct_sensitivity"],
                    "high_risk_threshold": risk.weights()["bands"]["high_dm_prob"],
                },
                "is_synthetic": True,
            }


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


if __name__ == "__main__":
    if not DB.exists():
        sys.exit(f"No DB at {DB}. Run:  python3 server/bootstrap.py")

    # An EXISTING but EMPTY database is the more dangerous case: a half-finished
    # bootstrap leaves a valid-looking file, the server starts happily, and the
    # first thing a judge sees is a dashboard of zeroes. Fail loudly here instead.
    try:
        with db() as _c:
            n = _c.execute("SELECT COUNT(*) FROM screenings").fetchone()[0]
    except sqlite3.Error as e:
        sys.exit(f"DB at {DB} is unusable ({e}). Re-run:  python3 server/bootstrap.py")
    if n == 0:
        sys.exit(f"DB at {DB} has no screenings — bootstrap did not finish.\n"
                 f"Re-run:  python3 server/bootstrap.py")

    ip = lan_ip()
    print("=" * 62)
    print("  NIROGYA  —  ASHA screening + district dashboard")
    print("=" * 62)
    print(f"  Local     http://localhost:{PORT}/")
    print(f"  Phone     http://{ip}:{PORT}/     <- judges open THIS")
    print(f"  Dashboard http://localhost:{PORT}/#/dashboard")
    print(f"  DB        {DB}  ({n} screenings)")
    print("  Data is SYNTHETIC and labelled as such in the UI.")
    print("=" * 62)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()

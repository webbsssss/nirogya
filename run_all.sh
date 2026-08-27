#!/usr/bin/env bash
# Nirogya: full build + verification, one command.
#
# Run this before you demo. Run it after anyone touches risk.py or risk.js.
# If it does not end in ALL GREEN, do not demo that build.
#
#   ./run_all.sh              # build into server/nirogya.db, verify
#   NIROGYA_DB=/tmp/n.db ./run_all.sh
#
# Eight stages, ending with the front-end driven against the real server. The
# test stages never write to the demo database — stage 8 serves a throwaway copy —
# and the last check proves it, because test rows score HIGH and would otherwise
# sort to the top of the roster a judge sees.
#
# Requires: Python 3.8+ (as python3, python, or py) and node (18+).
# No pip, no npm, no network.

set -uo pipefail
cd "$(dirname "$0")"

# MUST be exported, not just assigned: app.py reads PORT from the ENVIRONMENT.
# Without `export` the server silently binds its default 8000 while the health
# check below polls 8010, and stage 5 fails with an empty server log and no
# explanation. Cost an hour once — leave the export alone.
export PORT="${PORT:-8010}"
GREEN=$'\033[32m'; RED=$'\033[31m'; DIM=$'\033[2m'; OFF=$'\033[0m'
fails=0
step() { printf '\n%s=== %s ===%s\n' "$DIM" "$1" "$OFF"; }
verdict() {
  if [ "$1" -eq 0 ]; then printf '%s  PASS%s  %s\n' "$GREEN" "$OFF" "$2"
  else printf '%s  FAIL%s  %s\n' "$RED" "$OFF" "$2"; fails=$((fails+1)); fi
}

# Find a Python that actually RUNS, not merely one that is on PATH.
#
# On Windows, `command -v python3` SUCCEEDS even with no Python installed: the
# Microsoft Store ships a stub at WindowsApps/python3.exe that prints "Python was
# not found" and exits non-zero. A `command -v` guard therefore passes and every
# Python stage then fails with a message that looks nothing like the real cause.
# So probe by executing code, and accept the first candidate that answers.
PY=""
for cand in python3 python py; do
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c 'import sys; sys.exit(0 if sys.version_info >= (3,8) else 1)' >/dev/null 2>&1; then
    PY="$cand"; break
  fi
done
[ -n "$PY" ] || { echo "no working Python 3.8+ found (tried python3, python, py)"; exit 1; }
command -v node >/dev/null || { echo "node not found"; exit 1; }
printf '%susing %s (%s) and node %s%s\n' \
  "$DIM" "$PY" "$("$PY" -c 'import sys;print(".".join(map(str,sys.version_info[:3])))')" "$(node --version)" "$OFF"

# The database the demo actually runs off. Every stage that READS the cohort uses
# this one; stage 8 deliberately writes to a copy instead (see the note there).
export DEMO_DB="${NIROGYA_DB:-server/nirogya.db}"

# Row counts, so the harness can PROVE the test stages left the demo database
# alone instead of us assuming they did.
db_counts() {
  "$PY" -c 'import os, sqlite3
c = sqlite3.connect(os.environ["DEMO_DB"])
print(*(c.execute("select count(*) from " + t).fetchone()[0] for t in ("patients", "screenings")))' 2>/dev/null || echo unreadable
}

step "1/8  build cohort, train model, generate DB"
"$PY" server/bootstrap.py 2>&1 | tail -24
verdict "${PIPESTATUS[0]}" "bootstrap"

# Fingerprint the freshly built database. Stage 8 compares against this to prove
# the tests did not write into the demo data.
DB_BEFORE="$(db_counts)"

step "2/8  cohort plausibility gate (prevalences + risk-factor gradients)"
"$PY" server/check_cohort.py 2>&1 | tail -32
verdict "${PIPESTATUS[0]}" "cohort checks"

step "3/8  regenerate boundary cases"
# gen_parity_cases.py writes the case file to stdout by design, so it MUST be
# redirected — otherwise 1 MB of JSON lands in your terminal and the real output
# scrolls away.
#
# Redirect to a TEMP file and move it into place only on success. Writing the
# real fixture directly is destructive: the shell truncates a redirect target
# BEFORE running the command, so any failure here (a missing interpreter, a typo
# in the generator) replaces 2.5 MB of test cases with 0 bytes. Stage 4 then dies
# on "Unexpected end of JSON input", which points at the parser rather than at
# the generator that actually broke. Cost us the fixture once — keep the temp file.
CASES=tests/parity_cases.json
"$PY" tests/gen_parity_cases.py > "$CASES.tmp"
rc=$?
if [ "$rc" -eq 0 ] && [ -s "$CASES.tmp" ]; then
  mv -f "$CASES.tmp" "$CASES"
  echo "  wrote $CASES ($(wc -c < "$CASES") bytes, $("$PY" -c 'import json;print(json.load(open("tests/parity_cases.json"))["n"])') cases)"
else
  rc=1
  rm -f "$CASES.tmp"
  echo "  generation failed — kept the existing $CASES untouched"
fi
verdict "$rc" "parity case generation"

step "4/8  Python <-> JavaScript scoring parity"
node tests/parity_test.js 2>&1 | tail -12
verdict "${PIPESTATUS[0]}" "risk.py == risk.js"

step "5/8  voice input: spoken-number and yes/no parsing"
node tests/voice_test.mjs 2>&1 | tail -20
verdict "${PIPESTATUS[0]}" "voice parsing"

step "6/8  server-side input validation (nothing reaches the scorer unchecked)"
"$PY" tests/validate_test.py 2>&1 | tail -16
verdict "${PIPESTATUS[0]}" "input validation"

step "7/8  app shell: precache completeness + CSP conformance"
node tests/shell_test.mjs 2>&1 | tail -14
verdict "${PIPESTATUS[0]}" "shell + CSP"

step "8/8  end-to-end: offline capture -> queue -> sync -> dashboard"
# The e2e suite WRITES to whatever database the server is pointed at. It saves
# screenings, syncs them, and deliberately stores a patient whose NAME contains
# markup in order to prove the renderer escapes it instead of executing it.
#
# None of that may touch the demo database. The roster sorts by DESCENDING risk
# and the test records all score HIGH, so they sort ABOVE every real patient: the
# first three names on the dashboard become "E2E Test 1787809434566", "E2E
# Isolation acdfaeab" and a literal "<img src=x onerror=alert(1)>". That is not a
# hypothetical — it is what this database looked like before this stage was fixed.
#
# So serve a disposable COPY. A copy rather than an empty file, because the suite
# reads the built cohort: the roster, the village aggregates and NRG1020's
# seven-visit trend all have to be present for its assertions to mean anything.
#
# The path is deliberately repo-relative and NOT under /tmp. MSYS (Git Bash)
# rewrites POSIX-looking paths when it hands an environment variable to
# python.exe, so NIROGYA_DB=/tmp/e2e.db reaches the server as
# C:/Users/.../tmp/e2e.db. The server would create that file happily, the copy
# would go unused, and the demo database would be written after all — silently
# undoing this stage while still reporting green.
E2E_DB=server/nirogya_e2e.db

# Windows releases a file handle ASYNCHRONOUSLY, so an `rm` issued immediately
# after `kill` races the dying server and loses: the delete fails with "Device or
# resource busy" and a 900 KB throwaway is left in the working tree. Wait for the
# process to be reaped first, then retry briefly.
rm_e2e_db() {
  local i
  for i in $(seq 1 10); do
    rm -f "$E2E_DB" "$E2E_DB-journal" "$E2E_DB-wal" "$E2E_DB-shm" 2>/dev/null
    [ -e "$E2E_DB" ] || return 0
    sleep 0.2
  done
  return 1
}

rm_e2e_db || {
  # A leftover here is almost always a server from an earlier run that is still
  # holding the file — name it, because the copy below would otherwise silently
  # serve stale data.
  echo "  ($E2E_DB is locked by another process — an app.py from a previous run?)"
}
cp "$DEMO_DB" "$E2E_DB" 2>/dev/null
if [ ! -s "$E2E_DB" ]; then
  # Do NOT fall back to the demo database. A green e2e is not worth handing the
  # judges a roster topped by test rows, so an un-isolatable run is a failure.
  echo "could not copy $DEMO_DB to $E2E_DB — refusing to run the tests against"
  echo "the demo database, so this counts as a failed stage rather than a risk."
  verdict 1 "end-to-end"
else
  NIROGYA_DB="$E2E_DB" "$PY" server/app.py >/tmp/nirogya_e2e_server.log 2>&1 &
  SRV=$!
  trap 'kill $SRV 2>/dev/null' EXIT
  for _ in $(seq 1 40); do
    curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null && break
    sleep 0.3
  done
  if ! curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null; then
    echo "server did not answer /api/health on port ${PORT} after 12s"
    echo "--- server log (/tmp/nirogya_e2e_server.log) ---"
    tail -20 /tmp/nirogya_e2e_server.log
    # An EMPTY log here almost always means the server came up on a DIFFERENT port
    # than we polled, so check what it actually bound before hunting for a crash.
    if [ ! -s /tmp/nirogya_e2e_server.log ]; then
      echo "(log is empty — the server likely bound a different port, or died before"
      echo " printing. PORT=${PORT}; is PORT exported? Is something else on ${PORT}?)"
    fi
    verdict 1 "end-to-end"
  else
    ORIGIN="http://127.0.0.1:${PORT}" node tests/e2e_test.mjs 2>&1 | tail -30
    verdict "${PIPESTATUS[0]}" "end-to-end"
    # Any 500 from the API is a demo-killer even if assertions passed.
    errs=$(grep -c '!!' /tmp/nirogya_e2e_server.log || true)
    [ "$errs" -eq 0 ]; verdict $? "no server-side exceptions ($errs)"
  fi
  # `wait` matters as much as `kill`: without it the shell moves on while the
  # server is still shutting down, and the cleanup below cannot delete the file.
  kill $SRV 2>/dev/null; wait $SRV 2>/dev/null; trap - EXIT
  # Keep the copy only when something failed — it is the evidence you debug from.
  # Removing it on success keeps a 900 KB throwaway out of the working tree.
  if [ "$fails" -eq 0 ]; then
    rm_e2e_db || echo "  (could not remove $E2E_DB — it is a disposable copy, safe to delete by hand)"
  else
    echo "  kept $E2E_DB for post-mortem (disposable; stage 8 recreates it)"
  fi
fi

# Regression guard on the isolation above. Cheap, and it fails loudly the moment
# someone reintroduces a test that writes to the demo data.
DB_AFTER="$(db_counts)"
[ "$DB_BEFORE" = "$DB_AFTER" ]
verdict $? "demo database untouched by the tests (patients/screenings: $DB_BEFORE)"

printf '\n%s\n' "------------------------------------------------------------"
if [ "$fails" -eq 0 ]; then
  printf '%sALL GREEN%s — safe to demo this build.\n\n' "$GREEN" "$OFF"
  exit 0
fi
printf '%s%d STAGE(S) FAILED%s — do not demo until this is green.\n\n' "$RED" "$fails" "$OFF"
exit 1

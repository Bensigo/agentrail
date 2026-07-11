#!/usr/bin/env bash
# .agentrail/qa.sh — the QA-phase harness for AgentRail's own console (#1148, AC5).
#
# CONTRACT (shared by every repo's qa.sh, invoked by agentrail/run/qa_phase.py):
#   Usage:   qa.sh <artifacts_dir>
#   Exit 0 → QA passed;  any non-zero → QA failed.
#   Write screenshots / logs / notes under <artifacts_dir>. Only the BASENAMES of
#   those files are surfaced downstream (no host path leaks); the file bodies are
#   captured into run.json's bounded, secret-scrubbed log tail.
#
# WHAT THIS HARNESS PROVES: the console actually boots and server-renders the
# authenticated dashboard — not a blank page, not a 500 — for a real DB-backed
# session. The console uses NextAuth's "database" session strategy, so the cookie
# value IS the sessions row's primary key: we mint a session directly in Postgres,
# drive the authed route with curl, and assert the workspace renders cleanly. This
# is exactly the "green objective gate but broken build" gap QA exists to close.
#
# SCOPE / HONESTY: this repo ships no headless browser (no Playwright/Puppeteer),
# so this is an SSR-level smoke check. It reliably catches a blank page, a 5xx, a
# render-time throw, or a 404'd/again-un-authed route. It does NOT observe a
# client-only `console.error` on an otherwise-rendered page — a follow-up can add a
# Playwright pass here (the <artifacts_dir> contract already accommodates it).
#
# SAFETY: cleanup DELETEs the session row by its EXACT token only — never by
# user_id. A broad `DELETE ... WHERE user_id = <dev>` once wiped a real runner
# login; the mint token is unique-per-run so the exact-token delete is surgical.
set -uo pipefail

ARTIFACTS_DIR="${1:?usage: qa.sh <artifacts_dir>}"
mkdir -p "$ARTIFACTS_DIR"
NOTES="$ARTIFACTS_DIR/notes.md"

# --- Config (all overridable by the environment) -----------------------------
BASE_URL="${QA_BASE_URL:-http://localhost:3000}"
DATABASE_URL="${DATABASE_URL:-postgres://agentrail:agentrail@127.0.0.1:5434/agentrail}"
export DATABASE_URL
WORKSPACE_ID="00000000-0000-0000-0000-000000000001"   # seed.ts DEV_WORKSPACE_ID
USER_ID="00000000-0000-0000-0000-000000000002"        # seed.ts DEV_USER_ID
USER_EMAIL="codex-local@example.com"
DASHBOARD_PATH="/dashboard/${WORKSPACE_ID}"
BOOT_TIMEOUT="${QA_BOOT_TIMEOUT:-90}"                  # seconds to wait for a cold boot

# A unique, per-run token so the cleanup DELETE can key on the exact primary key.
TOKEN="qa-$(uuidgen 2>/dev/null || echo "$$-${RANDOM}-${RANDOM}")"

STARTED_SERVER=""    # PID of a console we started ourselves (empty ⇒ reuse mode)

log() { printf '%s\n' "$*" | tee -a "$NOTES" >&2; }

# Raw SQL against the linked Postgres. Prefer host psql; fall back to the compose
# service. Returns non-zero (and a clear message) if neither is reachable.
sql() {
  if command -v psql >/dev/null 2>&1; then
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qtA -c "$1"
  elif command -v docker >/dev/null 2>&1; then
    docker compose exec -T postgres \
      psql -U agentrail -d agentrail -v ON_ERROR_STOP=1 -qtA -c "$1"
  else
    echo "qa.sh: no psql and no docker to reach Postgres" >&2
    return 127
  fi
}

# --- Cleanup: surgical, unconditional ----------------------------------------
cleanup() {
  local ec=$?
  # Delete ONLY the session we minted, by exact primary key. NEVER by user_id.
  sql "DELETE FROM sessions WHERE session_token = '${TOKEN}';" >/dev/null 2>&1 || true
  if [ -n "$STARTED_SERVER" ]; then
    kill "$STARTED_SERVER" >/dev/null 2>&1 || true
    wait "$STARTED_SERVER" 2>/dev/null || true
  fi
  return "$ec"
}
trap cleanup EXIT

fail() { log "❌ QA FAILED: $*"; exit 1; }

# --- 1. Postgres reachable ---------------------------------------------------
{
  echo "# QA report"
  echo
  echo "- base_url: ${BASE_URL}"
  echo "- route: ${DASHBOARD_PATH}"
  echo
} > "$NOTES"

sql "SELECT 1;" >/dev/null 2>&1 || fail "cannot reach Postgres via DATABASE_URL"

# --- 2. Ensure the console is up (reuse if already serving, else boot it) -----
http_probe() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$BASE_URL" 2>/dev/null || echo "000"
}

if [ "$(http_probe)" = "000" ]; then
  log "console not up at ${BASE_URL}; booting it (build deps → next dev)…"
  # The console imports the BUILT dist/ of @agentrail/db-postgres; build it (and
  # mcp) first or the authed route 500s with an empty body ("X is not a function").
  pnpm --filter @agentrail/db-postgres --filter @agentrail/mcp build \
    >"$ARTIFACTS_DIR/deps-build.log" 2>&1 || fail "failed to build console deps"
  pnpm --filter @agentrail/console dev >"$ARTIFACTS_DIR/console.log" 2>&1 &
  STARTED_SERVER=$!
  waited=0
  until [ "$(http_probe)" != "000" ]; do
    if ! kill -0 "$STARTED_SERVER" 2>/dev/null; then
      fail "console process exited during boot (see console.log)"
    fi
    if [ "$waited" -ge "$BOOT_TIMEOUT" ]; then
      fail "console did not come up within ${BOOT_TIMEOUT}s"
    fi
    sleep 2; waited=$((waited + 2))
  done
  log "console is up after ~${waited}s"
else
  log "console already serving at ${BASE_URL} (reuse mode)"
fi

# --- 3. Mint a DB-backed session (self-seed the FK deps on a fresh DB) --------
# seed.ts never inserts the users row (it only appears after a real OAuth login),
# yet sessions.user_id FKs users.id — so insert the user first. Workspace +
# membership are normally seeded; upsert them too so a freshly-migrated DB works.
sql "INSERT INTO users (id, email) VALUES ('${USER_ID}', '${USER_EMAIL}') ON CONFLICT DO NOTHING;" >/dev/null \
  || fail "could not upsert dev user"
sql "INSERT INTO workspaces (id, name, slug) VALUES ('${WORKSPACE_ID}', 'Dev Workspace', 'dev') ON CONFLICT DO NOTHING;" >/dev/null \
  || fail "could not upsert dev workspace"
sql "INSERT INTO workspace_memberships (user_id, workspace_id, role) VALUES ('${USER_ID}', '${WORKSPACE_ID}', 'owner') ON CONFLICT DO NOTHING;" >/dev/null \
  || fail "could not upsert workspace membership"
sql "INSERT INTO sessions (session_token, user_id, expires) VALUES ('${TOKEN}', '${USER_ID}', now() + interval '2 hours');" >/dev/null \
  || fail "could not mint session"
log "minted session (token elided)"

# --- 4. Drive the authed dashboard and assert it renders cleanly -------------
RESP_FILE="$ARTIFACTS_DIR/dashboard.html"
HTTP_CODE=$(curl -s -o "$RESP_FILE" -w '%{http_code}' \
  -b "authjs.session-token=${TOKEN}" \
  --max-time 30 \
  "${BASE_URL}${DASHBOARD_PATH}" 2>/dev/null || echo "000")
log "GET ${DASHBOARD_PATH} → HTTP ${HTTP_CODE}"

[ "$HTTP_CODE" = "200" ] || fail "dashboard returned HTTP ${HTTP_CODE} (expected 200)"

# The workspace name is server-rendered outside the streaming Suspense boundary,
# so it must be present in the very first HTML the server sends.
grep -q "Dev Workspace" "$RESP_FILE" \
  || fail "authed dashboard did not render the workspace ('Dev Workspace' absent)"

# Reject Next.js error surfaces even on a 200 (error boundaries render 200 HTML).
for marker in "Internal Server Error" "Application error:" "This page could not be found" "__next_error__"; do
  if grep -qF "$marker" "$RESP_FILE"; then
    fail "dashboard HTML contains an error surface: '${marker}'"
  fi
done

log "✅ QA PASSED: dashboard rendered 'Dev Workspace' with no error surface"
{
  echo
  echo "## Result: PASSED"
  echo "- http_status: ${HTTP_CODE}"
  echo "- asserted: body contains 'Dev Workspace'; no error surfaces"
  echo "- artifacts: $(ls -1 "$ARTIFACTS_DIR" | tr '\n' ' ')"
} >> "$NOTES"
exit 0

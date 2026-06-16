#!/usr/bin/env bash
# AgentRail sandbox entrypoint.
#
# Args: <repo_url> <ref> <issue_ref>
#
# Clones the repo at ref into /workspace, runs `agentrail run issue <ref>`, then
# emits a sentinel-fenced result JSON on stdout for the host seam to parse
# (agentrail/sandbox/docker_runner.py). The fence lets the host pull the verdict
# out regardless of any trailing log noise.
#
# Required env (forwarded by the dispatcher via `docker run -e KEY`):
#   ANTHROPIC_API_KEY / OPENAI_API_KEY   agent CLI credential
#   GIT_TOKEN                            HTTPS clone token for private repos
set -uo pipefail

REPO_URL="${1:?repo_url required}"
REF="${2:?ref required}"
ISSUE_REF="${3:?issue_ref required}"

RESULT_BEGIN="===AGENTRAIL_RESULT_BEGIN==="
RESULT_END="===AGENTRAIL_RESULT_END==="

LOG_DIR="/workspace/.agentrail-runs"
RUN_ID="sandbox-issue-${ISSUE_REF}"

emit_result() {
  # status cost_usd branch gate_reason
  python3 - "$1" "$2" "$3" "$4" <<'PY'
import json, sys
status, cost, branch, reason = sys.argv[1:5]
try:
    cost = float(cost)
except ValueError:
    cost = 0.0
print("===AGENTRAIL_RESULT_BEGIN===")
print(json.dumps({"status": status, "cost_usd": cost,
                  "branch": branch, "gate_reason": reason}))
print("===AGENTRAIL_RESULT_END===")
PY
}

# --- auth for private clone over HTTPS ---------------------------------------
CLONE_URL="$REPO_URL"
if [ -n "${GIT_TOKEN:-}" ] && printf '%s' "$REPO_URL" | grep -q '^https://'; then
  CLONE_URL="$(printf '%s' "$REPO_URL" | sed "s#https://#https://x-access-token:${GIT_TOKEN}@#")"
fi

echo "==> cloning ${REPO_URL} @ ${REF}"
if ! git clone --depth 50 "$CLONE_URL" /workspace/repo >&2; then
  emit_result "error" "0" "" "git clone failed"
  exit 1
fi
cd /workspace/repo || { emit_result "error" "0" "" "workspace missing"; exit 1; }
git checkout "$REF" >&2 2>&1 || git checkout -b "$REF" "origin/$REF" >&2 2>&1 || true

# --- run the spine -----------------------------------------------------------
echo "==> agentrail run issue ${ISSUE_REF}"
agentrail run issue "$ISSUE_REF" --run-id "$RUN_ID" --log-dir "$LOG_DIR" >&2
RUN_STATUS=$?

# --- read the verdict + cost out of the run artifacts ------------------------
python3 - "$LOG_DIR/$RUN_ID" "$RUN_STATUS" <<'PY'
import json, os, sys

run_dir, run_status = sys.argv[1], sys.argv[2]
run_status = int(run_status)

status = "error"
cost = 0.0
branch = ""
reason = ""

run_json = os.path.join(run_dir, "run.json")
try:
    with open(run_json) as f:
        data = json.load(f)
    gate = data.get("objectiveGate") or {}
    verdict = gate.get("verdict")
    if verdict == "green":
        status = "green"
    elif verdict == "red":
        status = "red"
        reasons = gate.get("failedReasons") or []
        reason = "; ".join(str(r) for r in reasons)
    else:
        # No gate recorded: fall back to the process exit status.
        status = "green" if run_status == 0 else "red"
        if status == "red":
            reason = f"agentrail run exited {run_status}"
except FileNotFoundError:
    status = "green" if run_status == 0 else "error"
    if status != "green":
        reason = "run.json not found; agentrail run did not complete"
except (ValueError, OSError) as exc:
    status = "error"
    reason = f"could not read run result: {exc}"

# Cost: sum the per-phase cost ledger written by the pipeline.
ledger = os.path.join(os.getcwd(), ".agentrail", "run", "cost-events.jsonl")
try:
    with open(ledger) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                cost += float(json.loads(line).get("cost_usd") or 0.0)
            except (ValueError, TypeError):
                pass
except (FileNotFoundError, OSError):
    pass

# Current branch the run produced.
try:
    import subprocess
    branch = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        capture_output=True, text=True,
    ).stdout.strip()
except Exception:
    pass

print("===AGENTRAIL_RESULT_BEGIN===")
print(json.dumps({"status": status, "cost_usd": cost,
                  "branch": branch, "gate_reason": reason}))
print("===AGENTRAIL_RESULT_END===")
PY

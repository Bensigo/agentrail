# Langfuse Tracing + Evals (P1 + Phase 1 + Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire agentrail's run pipeline and Jace's Eve agent into a locally self-hosted Langfuse — traces + cost (Phase 1), truth-scores + shadow-judge + calibration report (Phase 2) — per `docs/prd/langfuse-tracing-shadow-judge-integration.md`.

**Architecture:** Agentrail talks to Langfuse's stable public REST API directly via stdlib `urllib` (house pattern: `agentrail/run/cost_push.py`) — no Python SDK dependency, trace IDs derived deterministically from `run_id` so score-push needs no lookup. Jace registers `@langfuse/otel`'s `LangfuseSpanProcessor` inside Eve's auto-discovered `agent/instrumentation.ts` `setup` callback; Eve already emits the full turn/model/tool span tree via the AI SDK.

**Tech Stack:** Python ≥3.9 stdlib only (urllib, hashlib, json) · Node ≥24, Eve 0.19.0 (exact pin), `ai@7.0.11`, `@langfuse/otel` · Langfuse v3 self-hosted via docker compose (pinned tag).

**Phase 3 (fingerprint datasets + experiments) is deliberately NOT in this plan** — it needs real scored traces to exist first. It gets its own plan after Phase 2 ships.

## Global Constraints

- **Flags default-OFF.** `AGENTRAIL_LANGFUSE_ENABLED` gates all agentrail tracing; unset Langfuse env keys gate Jace. Flag-off = provably zero behavior change and zero network attempts.
- **`PRICE_TABLE` (`agentrail/context/pricing.py`) is the sole price source.** Agentrail sends explicit `costDetails` computed by `agentrail/run/pricing.py`; Jace's prices are synced FROM `PRICE_TABLE` into Langfuse model definitions. Langfuse never invents a price.
- **All tracing code is non-fatal.** Every Langfuse call sits in its own `try/except` (mirroring the cost block at `agentrail/run/pipeline.py:523-544`); a Langfuse outage must never fail a run. Log at `debug`/`warning`, never raise.
- **No new Python dependencies.** REST via `urllib.request` only.
- **Env var names:** `AGENTRAIL_LANGFUSE_ENABLED`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST` (agentrail; accept `LANGFUSE_BASE_URL` as fallback), `LANGFUSE_BASE_URL` (Jace — the TS SDK's native name), `AGENTRAIL_LANGFUSE_SESSION_ID` (AFK→CLI propagation).
- **Deterministic trace id:** `sha256("agentrail:" + run_id).hexdigest()[:32]` — 32 lowercase hex chars (valid W3C/Langfuse trace id). Both the tracer and the score-push CLI compute it; they must share one function.
- **Repo rules:** PR-per-change (grouping below). Tests live under `agentrail/tests/observability/`. Run scoped tests (`pytest agentrail/tests/observability -q`), not the full 18.5-min suite, during the loop; full suite once per PR before push. If a `grep`/`Grep` call is blocked by the hard-mode hook, use `Read` on known paths or `agentrail context query` instead.
- **Docs-first pinning:** any step marked **PIN** requires fetching the named Langfuse docs page and recording the verified field/method names in the code as written — never proceed on memory if the step's assumption fails; stop and report instead.

**PR grouping:**
- PR 1 = Tasks 1–4 (agentrail tracer + pipeline wiring + AFK session propagation)
- PR 2 = Task 5 (price-sync CLI)
- PR 3 = Task 6 (local compose + setup doc)
- PR 4 = Task 7 (Jace instrumentation)
- PR 5 = Tasks 8 + 9 (score-push CLI + calibration report)
- PR 6 = Task 10 (Jace verdict → score hook)

---

### Task 0 (P1 prerequisite): cost-capture smoke run

Not a code task — an evidence task. The 0/54 empty dogfood cost ledgers are explained (feature landed 2026-06-12 #503; judged runs were June 4–12), but the seam has never been proven in dogfood. Prove it before building on it.

**Files:** none created in-repo; evidence pasted into the tracking issue / PR 1 description.

- [ ] **Step 1: Run one prompt-mode run against a scratch clone**

```bash
# fresh scratch clone (never the working checkout — AFK/run mutates trees)
git clone --depth 1 https://github.com/Bensigo/agentrail.git /tmp/agentrail-smoke
cd /tmp/agentrail-smoke
AGENTRAIL_ALLOW_SOURCE_RUN=1 ./agentrail/scripts/agentrail run \
  --prompt "Add a one-line comment to README.md explaining what agentrail is" \
  --target .
```

- [ ] **Step 2: Verify the ledger populated**

```bash
cat /tmp/agentrail-smoke/.agentrail/run/cost-events.jsonl
```
Expected: ≥1 JSON line per executed phase, each with a nonzero token count and a `cost` field. If the file is missing or empty, STOP — diagnose `capture_usage` (`agentrail/run/usage_capture.py`) before any Phase 1 work; the PRD's cost story depends on this seam.

- [ ] **Step 3: Record evidence** — paste the ledger lines + the run id into PR 1's description under "P1 evidence".

---

### Task 1: `langfuse_client.py` — REST client, flag, deterministic IDs

**Files:**
- Create: `agentrail/observability/__init__.py` (empty)
- Create: `agentrail/observability/langfuse_client.py`
- Test: `agentrail/tests/observability/test_langfuse_client.py` (+ empty `__init__.py` files mirroring the repo's test-package convention — check `agentrail/tests/run/` for the pattern)

**Interfaces (later tasks consume these exact names):**
- `enabled() -> bool` — true iff `AGENTRAIL_LANGFUSE_ENABLED` ∈ {"1","true","yes"} (case-insensitive)
- `deterministic_trace_id(run_id: str) -> str`
- `class LangfuseHTTP:` `from_env() -> Optional[LangfuseHTTP]` (None if any of host/public/secret key missing); `ingest(batch: list[dict]) -> None` (POST `/api/public/ingestion`); `get_json(path: str, params: dict) -> dict`; `post_json(path: str, body: dict) -> dict`. All methods raise on HTTP error (callers wrap in try/except); Basic auth `public_key:secret_key`.
- Module-level `_transport` seam: one function `_request(method, url, headers, data, timeout) -> tuple[int, bytes]` that tests monkeypatch — no real sockets in unit tests, ever.

- [ ] **Step 1: PIN** — fetch `https://langfuse.com/docs/api` (API reference index) and confirm: ingestion endpoint `POST /api/public/ingestion` with `{"batch": [{"id", "type", "timestamp", "body"}]}` envelope; event types `trace-create` and `generation-create`; auth is HTTP Basic with public key as username, secret key as password. Record the confirmed shape in the module docstring.

- [ ] **Step 2: Write the failing tests**

```python
# agentrail/tests/observability/test_langfuse_client.py
import json
import pytest
from agentrail.observability import langfuse_client as lc


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for var in ("AGENTRAIL_LANGFUSE_ENABLED", "LANGFUSE_PUBLIC_KEY",
                "LANGFUSE_SECRET_KEY", "LANGFUSE_HOST", "LANGFUSE_BASE_URL"):
        monkeypatch.delenv(var, raising=False)


def test_enabled_off_by_default():
    assert lc.enabled() is False


def test_enabled_accepts_truthy(monkeypatch):
    monkeypatch.setenv("AGENTRAIL_LANGFUSE_ENABLED", "TRUE")
    assert lc.enabled() is True


def test_deterministic_trace_id_stable_and_hex():
    tid = lc.deterministic_trace_id("run-20260713-abc")
    assert tid == lc.deterministic_trace_id("run-20260713-abc")
    assert len(tid) == 32 and int(tid, 16) >= 0


def test_from_env_returns_none_without_keys():
    assert lc.LangfuseHTTP.from_env() is None


def test_from_env_accepts_base_url_fallback(monkeypatch):
    monkeypatch.setenv("LANGFUSE_BASE_URL", "http://localhost:3000")
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk")
    client = lc.LangfuseHTTP.from_env()
    assert client is not None and client.base_url == "http://localhost:3000"


def test_ingest_posts_batch_with_basic_auth(monkeypatch):
    calls = []

    def fake_request(method, url, headers, data, timeout):
        calls.append((method, url, headers, data))
        return 207, b'{"successes": [], "errors": []}'

    monkeypatch.setattr(lc, "_request", fake_request)
    client = lc.LangfuseHTTP("http://localhost:3000", "pk", "sk")
    client.ingest([{"id": "1", "type": "trace-create", "timestamp": "t", "body": {}}])
    method, url, headers, data = calls[0]
    assert method == "POST" and url.endswith("/api/public/ingestion")
    assert headers["Authorization"].startswith("Basic ")
    assert json.loads(data)["batch"][0]["type"] == "trace-create"
```

- [ ] **Step 3: Run tests to verify they fail** — `pytest agentrail/tests/observability -q` → expected: import error / failures.

- [ ] **Step 4: Implement `langfuse_client.py`**

```python
# agentrail/observability/langfuse_client.py
"""Minimal Langfuse public-API client (stdlib only).

Pinned against the Langfuse API reference (see PR): ingestion is
POST /api/public/ingestion with a {"batch": [...]} envelope of
{id, type, timestamp, body} events; auth is HTTP Basic (public:secret).
House pattern mirrors agentrail/run/cost_push.py: urllib, non-fatal callers.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import urllib.request
from typing import Optional

_TIMEOUT = 10


def enabled() -> bool:
    return os.environ.get("AGENTRAIL_LANGFUSE_ENABLED", "").strip().lower() in (
        "1", "true", "yes",
    )


def deterministic_trace_id(run_id: str) -> str:
    return hashlib.sha256(f"agentrail:{run_id}".encode("utf-8")).hexdigest()[:32]


def _request(method, url, headers, data, timeout):
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # nosec B310 — https/local
        return resp.status, resp.read()


class LangfuseHTTP:
    def __init__(self, base_url: str, public_key: str, secret_key: str):
        self.base_url = base_url.rstrip("/")
        token = base64.b64encode(f"{public_key}:{secret_key}".encode()).decode()
        self._headers = {
            "Authorization": f"Basic {token}",
            "Content-Type": "application/json",
        }

    @classmethod
    def from_env(cls) -> Optional["LangfuseHTTP"]:
        host = os.environ.get("LANGFUSE_HOST") or os.environ.get("LANGFUSE_BASE_URL")
        pk = os.environ.get("LANGFUSE_PUBLIC_KEY")
        sk = os.environ.get("LANGFUSE_SECRET_KEY")
        if not (host and pk and sk):
            return None
        return cls(host, pk, sk)

    def ingest(self, batch: list) -> None:
        data = json.dumps({"batch": batch}).encode("utf-8")
        status, _ = _request("POST", f"{self.base_url}/api/public/ingestion",
                             self._headers, data, _TIMEOUT)
        if status >= 400:
            raise RuntimeError(f"langfuse ingestion HTTP {status}")

    def get_json(self, path: str, params: dict) -> dict:
        from urllib.parse import urlencode
        url = f"{self.base_url}{path}"
        if params:
            url = f"{url}?{urlencode(params)}"
        status, body = _request("GET", url, self._headers, None, _TIMEOUT)
        if status >= 400:
            raise RuntimeError(f"langfuse GET {path} HTTP {status}")
        return json.loads(body)

    def post_json(self, path: str, body: dict) -> dict:
        data = json.dumps(body).encode("utf-8")
        status, resp = _request("POST", f"{self.base_url}{path}",
                                self._headers, data, _TIMEOUT)
        if status >= 400:
            raise RuntimeError(f"langfuse POST {path} HTTP {status}")
        return json.loads(resp) if resp else {}
```

- [ ] **Step 5: Run tests** — `pytest agentrail/tests/observability -q` → all pass.
- [ ] **Step 6: Commit** — `git add agentrail/observability agentrail/tests/observability && git commit -m "feat(observability): stdlib Langfuse REST client, flag, deterministic trace ids"`

---

### Task 2: `tracer.py` — RunTracer over the REST client

**Files:**
- Create: `agentrail/observability/tracer.py`
- Test: `agentrail/tests/observability/test_tracer.py`

**Interfaces:**
- Consumes: `LangfuseHTTP.from_env`, `enabled`, `deterministic_trace_id` (Task 1, exact names above)
- Produces: `RunTracer.start(run_id: str, session_id: Optional[str] = None, metadata: Optional[dict] = None) -> RunTracer` — ALWAYS returns a tracer; when disabled/unconfigured it is inert. Methods: `phase_generation(phase: str, usage: dict, cost_usd: float, breakdown: Optional[dict], start_ts: float, model: Optional[str]) -> None`; `finish(exit_status: int) -> None`. No method ever raises.

- [ ] **Step 1: PIN** — fetch `https://langfuse.com/docs/api` generation-create body reference; confirm camelCase field names on the ingestion body: `traceId`, `startTime`, `endTime`, `usageDetails` (map of usage type → int), `costDetails` (map → USD float), `model`, `metadata`, and trace-create body: `id`, `sessionId`, `name`, `metadata`, `tags`. Adjust field names below if the pin disagrees; record in docstring.

- [ ] **Step 2: Write the failing tests**

```python
# agentrail/tests/observability/test_tracer.py
import pytest
from agentrail.observability import langfuse_client as lc
from agentrail.observability.tracer import RunTracer


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for var in ("AGENTRAIL_LANGFUSE_ENABLED", "LANGFUSE_PUBLIC_KEY",
                "LANGFUSE_SECRET_KEY", "LANGFUSE_HOST", "LANGFUSE_BASE_URL"):
        monkeypatch.delenv(var, raising=False)


@pytest.fixture
def capture(monkeypatch):
    """Flag on, env configured, transport captured. Fails the test on real IO."""
    batches = []

    def fake_request(method, url, headers, data, timeout):
        import json
        batches.append(json.loads(data)["batch"])
        return 207, b"{}"

    monkeypatch.setenv("AGENTRAIL_LANGFUSE_ENABLED", "1")
    monkeypatch.setenv("LANGFUSE_HOST", "http://localhost:3000")
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk")
    monkeypatch.setattr(lc, "_request", fake_request)
    return batches


def test_flag_off_makes_no_network_calls(monkeypatch):
    def explode(*a, **k):
        raise AssertionError("network attempted with flag off")
    monkeypatch.setattr(lc, "_request", explode)
    t = RunTracer.start("run-x")
    t.phase_generation("execute", {"input": 10, "output": 5}, 0.01, None, 0.0, "m")
    t.finish(0)  # must not raise, must not call _request


def test_trace_created_with_deterministic_id_and_session(capture):
    t = RunTracer.start("run-x", session_id="afk-42")
    t.finish(0)
    events = [e for batch in capture for e in batch]
    trace_creates = [e for e in events if e["type"] == "trace-create"]
    assert trace_creates[0]["body"]["id"] == lc.deterministic_trace_id("run-x")
    assert trace_creates[0]["body"]["sessionId"] == "afk-42"


def test_phase_generation_carries_explicit_cost(capture):
    t = RunTracer.start("run-x")
    t.phase_generation("verify", {"input": 100, "output": 20}, 0.0123,
                       {"input": 0.01, "output": 0.0023}, 1720000000.0, "opus")
    gens = [e for batch in capture for e in batch if e["type"] == "generation-create"]
    body = gens[0]["body"]
    assert body["traceId"] == lc.deterministic_trace_id("run-x")
    assert body["name"] == "verify"
    assert body["costDetails"]["total"] == 0.0123
    assert body["usageDetails"] == {"input": 100, "output": 20}


def test_transport_error_swallowed(capture, monkeypatch):
    def boom(*a, **k):
        raise OSError("connection refused")
    monkeypatch.setattr(lc, "_request", boom)
    t = RunTracer.start("run-x")
    t.phase_generation("execute", {"input": 1}, 0.0, None, 0.0, None)
    t.finish(1)  # nothing raises
```

- [ ] **Step 3: Run to verify failure** — `pytest agentrail/tests/observability/test_tracer.py -q` → import error.

- [ ] **Step 4: Implement `tracer.py`**

```python
# agentrail/observability/tracer.py
"""Per-run Langfuse tracer. Inert unless AGENTRAIL_LANGFUSE_ENABLED and env keys set.

Every public method is non-fatal by construction: a Langfuse outage or
misconfiguration must never affect a run (mirrors the cost block's contract
at agentrail/run/pipeline.py:523-544).
"""
from __future__ import annotations

import datetime
import logging
import uuid
from typing import Optional

from . import langfuse_client as lc

_log = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _ts_iso(ts: float) -> str:
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).isoformat()


class RunTracer:
    def __init__(self, client, run_id: str, session_id: str, metadata: dict):
        self._client = client            # None => inert
        self._trace_id = lc.deterministic_trace_id(run_id)
        self._run_id = run_id
        self._session_id = session_id
        self._metadata = metadata

    @classmethod
    def start(cls, run_id: str, session_id: Optional[str] = None,
              metadata: Optional[dict] = None) -> "RunTracer":
        client = lc.LangfuseHTTP.from_env() if lc.enabled() else None
        if lc.enabled() and client is None:
            _log.warning("AGENTRAIL_LANGFUSE_ENABLED set but LANGFUSE_* keys missing; "
                         "tracing disabled for this run")
        tracer = cls(client, run_id, session_id or run_id, metadata or {})
        tracer._emit([tracer._event("trace-create", {
            "id": tracer._trace_id,
            "name": f"agentrail-run:{run_id}",
            "sessionId": tracer._session_id,
            "metadata": {"run_id": run_id, **tracer._metadata},
            "tags": ["agentrail"],
        })])
        return tracer

    def phase_generation(self, phase: str, usage: dict, cost_usd: float,
                         breakdown: Optional[dict], start_ts: float,
                         model: Optional[str]) -> None:
        cost_details = dict(breakdown) if breakdown else {}
        cost_details["total"] = cost_usd
        self._emit([self._event("generation-create", {
            "traceId": self._trace_id,
            "name": phase,
            "model": model,
            "startTime": _ts_iso(start_ts) if start_ts else _now_iso(),
            "endTime": _now_iso(),
            "usageDetails": usage,
            "costDetails": cost_details,
        })])

    def finish(self, exit_status: int) -> None:
        self._emit([self._event("trace-create", {   # trace upsert: same id, new fields
            "id": self._trace_id,
            "metadata": {"run_id": self._run_id, "exit_status": exit_status},
        })])

    def _event(self, etype: str, body: dict) -> dict:
        return {"id": str(uuid.uuid4()), "type": etype,
                "timestamp": _now_iso(), "body": body}

    def _emit(self, batch: list) -> None:
        if self._client is None:
            return
        try:
            self._client.ingest(batch)
        except Exception as exc:
            _log.warning("langfuse emit failed (run continues): %s", exc)
```

- [ ] **Step 5: Run tests** — `pytest agentrail/tests/observability -q` → all pass.
- [ ] **Step 6: Commit** — `git commit -am "feat(observability): RunTracer — per-run trace, per-phase generation with explicit cost"`

---

### Task 3: Pipeline wiring

**Files:**
- Modify: `agentrail/run/pipeline.py` (three touch points: `_run_pipeline` start after run_id is final near the `write_run_metadata` call ~:1193; the cost block :523-544; the finish path ~:1575)
- Test: `agentrail/tests/observability/test_pipeline_wiring.py`

**Interfaces:**
- Consumes: `RunTracer.start / phase_generation / finish` (Task 2 signatures, exact).
- Produces: `rc.tracer` attribute on the run context object, set unconditionally (inert tracer when disabled) so the phase code needs no `if`.

- [ ] **Step 1: Locate the exact seams (Read, don't grep):** Read `agentrail/run/pipeline.py:1180-1220` to find where `run_id` is final and `write_run_metadata` runs; Read the `RunContext` construction site to find where to attach `rc.tracer`; Read `agentrail/run/usage_capture.py` to record the exact key names of the `usage` dict that `capture_usage` returns and `cost_usd` consumes (map them 1:1 into `usageDetails`; if `cost_breakdown()` returns per-category dollars, pass it as `breakdown`). Record findings as comments in the test file.

- [ ] **Step 2: Write the failing test** — an integration-shaped unit test that stubs a minimal `rc` and calls the cost-block logic path:

```python
# agentrail/tests/observability/test_pipeline_wiring.py
"""Wiring contract: flag off => pipeline makes zero Langfuse calls;
flag on => one generation per phase cost-capture, cost passed through verbatim."""
import pytest
from agentrail.observability import langfuse_client as lc


def test_flag_off_pipeline_never_touches_transport(monkeypatch):
    monkeypatch.delenv("AGENTRAIL_LANGFUSE_ENABLED", raising=False)

    def explode(*a, **k):
        raise AssertionError("langfuse transport called with flag off")
    monkeypatch.setattr(lc, "_request", explode)

    from agentrail.observability.tracer import RunTracer
    t = RunTracer.start("run-inert")
    t.phase_generation("execute", {"input": 1}, 0.0, None, 0.0, None)
    t.finish(0)
```

Plus (same file) a test that imports the real wiring function once Step 3 lands — after writing Step 3, extend this test to call the extracted helper `_trace_phase_cost(rc, phase, usage, cost, phase_start_ts)` with a stub `rc` carrying a capture-mode tracer, asserting the generation body echoes `cost` exactly.

- [ ] **Step 3: Implement the wiring.** In `_run_pipeline`, immediately after `run_id` is final (adjacent to `write_run_metadata`, ~:1193):

```python
from agentrail.observability.tracer import RunTracer
import os as _os
rc.tracer = RunTracer.start(
    run_id,
    session_id=_os.environ.get("AGENTRAIL_LANGFUSE_SESSION_ID") or None,
    metadata={"agent": agent, "label": str(label)},
)
```

In the cost block (inside the existing `if usage:` at :526, after `push_cost_event`), add its own non-fatal call:

```python
try:
    rc.tracer.phase_generation(
        phase, usage, cost, cost_breakdown(usage), phase_start_ts,
        getattr(rc, "model", None),
    )
except Exception as _exc:
    _log.debug("langfuse phase trace skipped: %s", _exc)
```

(`cost_breakdown` is already imported in this module for the cost path — verify; if its return shape is not a flat category→USD dict, adapt per Step 1 findings.) At the finish path (~:1575, where `update_run_state(..., "finish", ...)` runs), add `rc.tracer.finish(status)` in a try/except. If `rc` is constructed before `run_id` exists, attach the tracer to `rc` right after construction instead and pass `run_id` at that point — follow what Step 1 found; the invariant is: tracer exists before the first phase call, is never None.

- [ ] **Step 4: Run** — `pytest agentrail/tests/observability -q` then the pipeline's own tests `pytest agentrail/tests/run -q` → all pass (proves no regression on the run path).
- [ ] **Step 5: Commit** — `git commit -am "feat(run): wire RunTracer into pipeline — trace per run, generation per phase cost-capture"`

---

### Task 4: AFK session propagation

**Files:**
- Modify: `agentrail/afk/runner.py` (where `Runner._implement` :243 builds the subprocess invocation via `_sh(...)` — `_sh` already accepts `env`)
- Test: `agentrail/tests/observability/test_afk_session_env.py`

**Interfaces:**
- Produces: every `agentrail` CLI subprocess an AFK run spawns carries `AGENTRAIL_LANGFUSE_SESSION_ID=afk-<issue-or-label>-<runner start iso>` in its env, constant across all phases/retries of that AFK item so Langfuse groups them into one session.

- [ ] **Step 1: Read `agentrail/afk/runner.py:200-320`** to find every `_sh(...)` call in `_implement` (and any sibling that launches the `agentrail` CLI). Note whether `env` is currently passed (default None → inherits).
- [ ] **Step 2: Failing test** — construct the session id the same way the implementation will and assert the env dict passed to `_sh` contains it (monkeypatch `_sh` to capture kwargs; drive `_implement` with a stub work item, mirroring how existing AFK tests in `agentrail/tests/afk/` stub it — copy their fixture pattern).
- [ ] **Step 3: Implement** — in `Runner.__init__` (or per-item start), compute `self._langfuse_session = f"afk-{label}-{start_iso}"`; at each `_sh` launch of the CLI: `env={**os.environ, "AGENTRAIL_LANGFUSE_SESSION_ID": self._langfuse_session}`. Do NOT set it when the flag machinery is absent — it's harmless metadata; unconditional is fine and keeps the code branch-free.
- [ ] **Step 4: Run** — `pytest agentrail/tests/observability -q && pytest agentrail/tests/afk -q` → pass.
- [ ] **Step 5: Commit + open PR 1** — full suite once (`pytest -q`, ~18.5 min, slow-not-hung), push branch `feat/langfuse-tracer-core`, PR body includes Task 0's P1 evidence.

---

### Task 5: Price-sync CLI (`agentrail langfuse sync-models`)

**Files:**
- Create: `agentrail/cli/commands/langfuse.py`
- Create: `agentrail/observability/price_sync.py`
- Test: `agentrail/tests/observability/test_price_sync.py`
- Modify: CLI registration (mirror how `agentrail/cli/commands/cost.py` registers — Read `cost.py` and `agentrail/cli/main.py` first; follow that pattern exactly)

**Interfaces:**
- Consumes: `PRICE_TABLE` from `agentrail/context/pricing.py` (Read it first: record its exact structure — model key → rate fields and their units, e.g. USD per token vs per MTok — and convert accordingly; get the unit conversion WRONG and every Jace cost is wrong, so add a test pinning one known model's expected per-token price).
- Produces: `sync_models(client: LangfuseHTTP, dry_run: bool = False) -> dict` returning `{"created": [names], "unchanged": [names], "stale": [names]}`; CLI `agentrail langfuse sync-models [--dry-run]`.

- [ ] **Step 1: PIN** — fetch `https://langfuse.com/docs/api` models section; confirmed already: `POST /api/public/models` (`modelName`, `matchPattern`, prices), `GET /api/public/models` (paginated), **no upsert, no documented delete** → idempotency is client-side: GET all, compare by `modelName`+prices, create only when missing or price-changed (a price change creates a NEWER definition, which wins by `startTime` resolution — document this in the module docstring). Confirm whether the modern `pricingTiers` or legacy `inputPrice/outputPrice` fields are accepted on create in the deployed compose version; use what the pin confirms and note it.
- [ ] **Step 2: Failing tests** — with `_request` monkeypatched: (a) empty remote → every PRICE_TABLE model POSTed with `matchPattern` = exact-escaped model name anchored (`^` + `re.escape(name)` + `$`); (b) remote already matching → zero POSTs, all "unchanged"; (c) price drift → POST issued, name in "created", old listed in "stale"; (d) unit-conversion pin: assert the exact per-token price emitted for one real PRICE_TABLE entry, hand-computed in the test comment; (e) `--dry-run` → zero POSTs, would-create names returned.
- [ ] **Step 3: Implement `price_sync.py` + the CLI command.** CLI errors cleanly (exit 1, one-line message) when `LangfuseHTTP.from_env()` is None. No flag check here — sync is an explicit operator action.
- [ ] **Step 4: Run scoped tests; then commit + PR 2** (`feat/langfuse-price-sync`).

---

### Task 6: Local compose + setup doc

**Files:**
- Create: `docs/langfuse-local.md`
- Create: `agentrail/observability/docker-compose.langfuse.yml` — copied verbatim from the Langfuse repo at a pinned release tag, with the source tag/URL and copy date in a header comment

- [ ] **Step 1:** `curl -fsSL https://raw.githubusercontent.com/langfuse/langfuse/<latest release tag>/docker-compose.yml` (resolve the tag via `gh release list -R langfuse/langfuse -L 1`). Verify it declares named volumes (`langfuse_postgres_data` — confirmed present on main 2026-07-13, re-verify at the pinned tag). Change nothing except adding the header comment; local secrets stay compose-default (localhost-only dev, documented as such).
- [ ] **Step 2:** Write `docs/langfuse-local.md`: start command (`docker compose -f agentrail/observability/docker-compose.langfuse.yml up -d`), first-login + project/API-key creation (Settings → API Keys), the exact env block for agentrail (`AGENTRAIL_LANGFUSE_ENABLED=1`, `LANGFUSE_HOST=http://localhost:3000`, keys) and for Jace (`LANGFUSE_BASE_URL=http://localhost:3000`, keys), the price-sync step (`agentrail langfuse sync-models`), and the persistence note (named volumes survive restarts; `docker compose down -v` wipes history — needed for calibration/datasets, don't `-v` casually).
- [ ] **Step 3:** Verify end-to-end by hand once: compose up → create keys → flag on → one scratch `agentrail run` → trace visible at `localhost:3000` with phase generations and costs matching the run's `cost-events.jsonl` to the cent. Paste a screenshot or the API `GET /api/public/traces/<id>` response into PR 3.
- [ ] **Step 4:** Commit + PR 3 (`docs/langfuse-local-setup`).

---

### Task 7: Jace `instrumentation.ts`

**Files:**
- Create: `apps/jace/agent/instrumentation.ts`
- Test: `apps/jace/tests/instrumentation.test.mjs` (mirror the existing `node --test` pattern used by `no-second-write-path.test.mjs` — Read one existing Jace test first and copy its conventions)
- Modify: `apps/jace/package.json` (add `@langfuse/otel`, `@langfuse/tracing`, `@vercel/otel` — exact versions, not ranges, matching the Eve-pin philosophy)

**Interfaces:**
- Produces: default export of `defineInstrumentation({ setup, events })`. When `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY`/`LANGFUSE_BASE_URL` are unset: `setup` registers OTel with **zero** span processors (Eve enables telemetry by the file's mere presence, so the no-key path must be explicitly inert).

- [ ] **Step 1: PIN (two facts, stop if either fails).** (a) Current `@langfuse/otel` major + whether `LangfuseSpanProcessor` reads `LANGFUSE_BASE_URL` env automatically — fetch `https://langfuse.com/docs/observability/sdk/typescript/setup`; the JS SDK majors moved recently (v4→v5 migration guide exists), pin what is current *today*. (b) The exact property names of the `step.started` callback input's session lineage — Read `apps/jace/node_modules/eve/` type declarations (find them: `ls apps/jace/node_modules/eve` then follow `package.json` `types`/`exports`; the guide documents "session: the session id ... and parent session lineage" but not property names). Record both pins as comments at the top of `instrumentation.ts`.
- [ ] **Step 2: Failing test** (`node --test apps/jace/tests/instrumentation.test.mjs`): imports the module, asserts (a) it default-exports an object with a `setup` function; (b) with LANGFUSE env vars deleted, calling `setup({ agentName: "jace" })` with a stubbed `registerOTel` (inject via the same mocking approach existing Jace tests use) passes an empty `spanProcessors` array; (c) with fake env keys set, exactly one processor is passed.
- [ ] **Step 3: Implement:**

```ts
// apps/jace/agent/instrumentation.ts
// PINS (2026-07-13): @langfuse/otel@<pinned> reads LANGFUSE_BASE_URL/PUBLIC_KEY/SECRET_KEY.
// step.started input session lineage: <verified property names from eve types>.
import { defineInstrumentation } from "eve/instrumentation";
import { registerOTel } from "@vercel/otel";
import { LangfuseSpanProcessor } from "@langfuse/otel";

const langfuseConfigured = Boolean(
  process.env.LANGFUSE_PUBLIC_KEY &&
  process.env.LANGFUSE_SECRET_KEY &&
  process.env.LANGFUSE_BASE_URL,
);

export default defineInstrumentation({
  setup: ({ agentName }) =>
    registerOTel({
      serviceName: agentName,
      spanProcessors: langfuseConfigured ? [new LangfuseSpanProcessor()] : [],
    }),
  events: {
    "step.started"(input) {
      if (!langfuseConfigured) return undefined;
      // Root session id groups the whole tree (root + subagent runs) into one
      // Langfuse session. Property names per the Step 1 pin.
      const sessionId = /* root session id from input.session per pin */
        input.session.rootId ?? input.session.id;
      return {
        runtimeContext: {
          "langfuse.session.id": sessionId,
          "eve.subagent": input.channel.kind === "subagent" ? "true" : "false",
        },
      };
    },
  },
});
```

The `langfuse.session.id` attribute name must be verified in the Step 1(a) pin (it is the v4-era OTel attribute for session mapping; if the pinned major uses a different name or a `propagateAttributes` helper, use that instead — the *deliverable* is: session id lands on Langfuse traces).
- [ ] **Step 4: Run** — `node --test apps/jace/tests/instrumentation.test.mjs` → pass; `cd apps/jace && npx eve build` (Node 24 on PATH — known env requirement) → build green, `.eve/diagnostics.json` clean.
- [ ] **Step 5: Manual smoke** (needs Task 6's compose running): `eve dev`, send one message through the dev TUI, confirm a trace with the `ai.eve.turn` root span appears in Langfuse; then trigger the triage subagent and confirm its turns share the root's session id. Screenshot into PR 4.
- [ ] **Step 6: Commit + PR 4** (`feat/jace-langfuse-instrumentation`).

---

### Task 8: Score-push CLI (`agentrail langfuse push-scores`)

**Files:**
- Create: `agentrail/observability/score_push.py`
- Modify: `agentrail/cli/commands/langfuse.py` (add subcommand next to `sync-models`)
- Test: `agentrail/tests/observability/test_score_push.py`

**Interfaces:**
- Consumes: `LangfuseHTTP`, `deterministic_trace_id` (Task 1); production run-records at `<target>/.agentrail/run-records/<run-id>.json` (assembled by `agentrail run-records`, PR #1180 — fields include `verify_verdict`, per-phase `verdict`); eval rep records at `<reports_dir>/run-records/<date>/<task>--<arm>--rep<N>.json` (PR #1176 — fields include `solved`, `false_green`, `synthetic`).
- Produces: `push_scores(client, records_dir: Path, judge_file: Optional[Path]) -> dict` → `{"pushed": int, "skipped": [{"record", "reason"}]}`; CLI `agentrail langfuse push-scores --records <dir> [--judge <ledger.json>] [--dry-run]`. **Fail-closed per record:** any record missing its run_id or verdict fields is counted in `skipped` with a reason and never blocks the rest — the judge pass must never be blocked by score-push.

- [ ] **Step 1: PIN + ground.** (a) Fetch the scores API reference: `POST /api/public/scores` body (`traceId`, `name`, `value`, `dataType` — confirm exact casing and the value convention for booleans: numeric 0/1 vs categorical string; use what the pin says and encode `solved`/`false_green`/`verify_verdict`/`judge_verdict` consistently). (b) Read ONE real record of each kind (`ls` the dirs first; they exist in dogfood history and `agentrail/evals/reports/`) and pin the exact key names in test fixtures — do not trust this plan's field list over the real files (eval-symbol-mismatch rule).
- [ ] **Step 2: Failing tests** — fixture dir with: one production record (verify verdict present), one eval rep record (`solved: true`), one synthetic eval record (must be SKIPPED with reason "synthetic" — network-artifact rows never become scores, per the synthetic-hygiene rule), one corrupt JSON (skipped, reason "unparseable"), plus a judge ledger entry keyed by run_id. Assert: each valid record → one `POST /api/public/scores` per score kind with `traceId == deterministic_trace_id(run_id)`; skip list is exact; `--dry-run` posts nothing.
- [ ] **Step 3: Implement.** Score names (fixed vocabulary, document in module docstring): `solved`, `false_green`, `verify_verdict`, `judge_verdict`. One POST per score.
- [ ] **Step 4: Run scoped tests → commit** (PR 5 branch `feat/langfuse-scores`, holds Tasks 8+9).

---

### Task 9: Calibration report (`agentrail langfuse calibration-report`)

**Files:**
- Create: `agentrail/observability/calibration.py`
- Modify: `agentrail/cli/commands/langfuse.py` (third subcommand)
- Test: `agentrail/tests/observability/test_calibration.py`

**Interfaces:**
- Consumes: `LangfuseHTTP.get_json` over `GET /api/public/scores` (PIN the list endpoint + pagination params in Step 1); score vocabulary from Task 8.
- Produces: `calibration(client) -> dict` → `{"n": int, "agreement": {"judge_vs_solved": float|None, "judge_vs_verify": float|None}, "insufficient": bool}`; CLI writes `agentrail/evals/reports/calibration-<YYYY-MM-DD>.md` with agreement rates AND sample sizes (a rate without its n is exactly the vanity-metric failure mode this exists to prevent; `n < 10` renders as "insufficient data", never a percentage).

- [ ] **Step 1: PIN** the scores list endpoint (params, pagination, filter-by-name).
- [ ] **Step 2: Failing tests** — canned API responses: (a) traces where judge and solved agree 3/4 → agreement 0.75, n=4; (b) traces with judge score but no truth score are excluded from n; (c) n=2 → `insufficient: true` and the markdown contains no percentage; (d) report file lands at the dated path and includes both n and the score-vocabulary version.
- [ ] **Step 3: Implement** (pure function over fetched scores; markdown writer separate and trivially testable).
- [ ] **Step 4: Run scoped tests; full suite once; commit + open PR 5.**

---

### Task 10: Jace verdict → score hook

**Files:**
- Create: `apps/jace/agent/hooks/langfuse-verdict-score.ts`
- Test: `apps/jace/tests/langfuse-verdict-score.test.mjs`

**Interfaces:**
- Consumes: Eve `defineHook` from `eve/hooks` (observe-only, per `node_modules/eve/docs/guides/hooks.md`); the triage subagent's structured output (`TRIAGE_SCHEMA`, `apps/jace/agent/subagents/triage/lib/triage.core.mjs:84`) and the QA subagent's verdict, both of which Eve lowers into the root's tool stream.
- Produces: on each completed triage/QA subagent result, one `POST /api/public/scores` with `sessionId` (NOT traceId — the OTel trace id is not visible to hooks; session-level scores attach to the session the instrumentation stamped) carrying `name: "triage_verdict" | "qa_verdict"`, the verdict value, and the subagent id in metadata. Fire-and-forget with a caught promise — a score failure must never surface into the agent.

- [ ] **Step 1: PIN + ground (three facts).** (a) Scores API accepts session-scoped scores (`sessionId` instead of `traceId`) — fetch the scores API reference; if it does NOT, fall back to: hook stores nothing and Task 10 is re-scoped to push verdict scores from the console/jace_messages side where the session id and verdict are both durably recorded — report back before building. (b) Read `node_modules/eve/docs/guides/hooks.md` + the hooks type declarations for the exact event carrying subagent results (`action.result` vs `message.completed`) and the payload property names. (c) Read `apps/jace/agent/subagents/triage/agent.ts:29-33` — the comment documents that Eve lowers task-mode structured output straight into root's tool stream; confirm the hook event view exposes it and which property holds the parsed verdict.
- [ ] **Step 2: Failing test** — feed the hook handler a synthetic event fixture (built from the Step 1(b) pinned shape): triage result event → exactly one fetch to `/api/public/scores` with the session id and verdict; non-subagent events → zero calls; fetch rejection → handler resolves without throwing.
- [ ] **Step 3: Implement** with `defineHook`, env-gated on the same three LANGFUSE vars, native `fetch` (Node 24), `.catch(() => {})` on the post with a single `console.warn`.
- [ ] **Step 4: Run** — `node --test`, `npx eve build` green, manual smoke against local compose (trigger triage once; score visible on the session). Commit + PR 6 (`feat/jace-verdict-scores`).

---

## Self-review notes (run before dispatch)

- Spec coverage: PRD Phase 1 items 1–6 → Tasks 1–7 + 0; Phase 2 items 7–9 → Tasks 8–10 (truth-scores ride Task 8 by reading run-records post-hoc — the evals spine itself stays untouched, per PRD non-goal). Phase 3 deferred by design, stated up top.
- The PRD's SDK-version lines ("Python SDK v3", "TS v4") are stale — docs now show Python v4 / JS v5 migration guides. Tasks 1–2 sidestep it entirely (REST); Task 7 Step 1 pins the real current major. Fix the PRD's P2 wording in the same PR as this plan.
- Type consistency: `RunTracer.start(run_id, session_id=None, metadata=None)` is identical in Tasks 2 (definition) and 3 (call site); `deterministic_trace_id` shared by Tasks 1, 2, 8; score vocabulary defined once in Task 8 and consumed by Task 9.

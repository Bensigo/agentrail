"""Per-run Langfuse tracer. Inert unless AGENTRAIL_LANGFUSE_ENABLED and env keys set.

Every public method is non-fatal by construction: a Langfuse outage or
misconfiguration must never affect a run (mirrors the cost block's contract
at agentrail/run/pipeline.py:523-544). This includes malformed inputs (e.g. a
NaN timestamp) — event-body construction happens inside the same guarded path
as the network call, so no public method can ever raise regardless of what is
passed in or what the transport does.

Field names verified against Langfuse API ingestion schema:
  trace-create body: id, sessionId, name, input, output, metadata, tags
  generation-create body: id, traceId, name, model, startTime, endTime, usageDetails, costDetails

`input`/`output` are first-class trace-level fields (TraceBody, verified against
the installed @langfuse/core types) — they populate the I/O columns of Langfuse's
trace list and detail view. Both are optional and only emitted when a caller
supplies them; `_prune` drops any None-valued key so an omitted field is never
sent as a literal null (trace-create merges at the field level, so a stray
`output: null` on the finish upsert would otherwise clobber a value set at
start()). Both are size-bounded (`_clip`/`_clip_json`) so a large issue body
can't blow up the ingestion POST, and — like every other body field — they are
constructed inside `_safe_emit`'s guarded lambda so a malformed value can never
raise.

`generation-create`'s body REQUIRES its own `id` (the observation's own identity,
distinct from the outer batch envelope's event id set by `_event()`) — omitting
it is rejected by the real ingestion endpoint with a 400 ("expected string,
received undefined" at body.id), confirmed against a live local Langfuse
instance (v3.212.0). Every existing test mocked `_request` and asserted only on
individual body fields, so this was never caught until a real E2E run: the
tracer's own non-fatal design meant every phase_generation call silently failed
in production while the run itself succeeded normally.

`costDetails` is documented as "USD cost per usage type" — every value a
number (https://langfuse.com/docs/observability/features/token-and-cost-tracking,
confirmed 2026-07-20). `phase_generation` therefore filters its `breakdown`
argument to numeric values only before folding it into `costDetails` (#1337
PR②: `agentrail.run.pricing.cost_breakdown()` gained a non-numeric
`price_source` field alongside its numeric `*_usd` components — forwarding
it verbatim would put a string/None inside an all-numeric field).
"""
from __future__ import annotations

import datetime
import json
import logging
import uuid
from typing import Optional

from . import langfuse_client as lc

_log = logging.getLogger(__name__)

# Upper bound on any single trace I/O field's serialized size. Bounds the
# ingestion POST payload so a large issue body / verdict blob can't blow up the
# 10s-timeout ingestion request.
_MAX_FIELD = 8000


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _ts_iso(ts: float) -> str:
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).isoformat()


def _prune(body: dict) -> dict:
    """Drop keys whose value is None so an omitted optional field is never sent
    as a literal null. Trace-create merges at the field level, so a stray
    `input: null`/`output: null` on an upsert would clobber a previously-set
    value; pruning keeps the body byte-identical to the pre-I/O behavior when
    no name/input/output is supplied."""
    return {k: v for k, v in body.items() if v is not None}


def _clip(value, limit: int = _MAX_FIELD):
    """Bound a string field's length; pass non-strings through untouched."""
    if isinstance(value, str) and len(value) > limit:
        return value[:limit]
    return value


def _clip_json(obj, limit: int = _MAX_FIELD):
    """Bound a JSON-able value's serialized size. Clips string leaves and caps
    list lengths; if the whole thing is still oversized, falls back to a clipped
    serialized string so the emitted field is always bounded."""
    clipped = _clip_leaves(obj, limit)
    try:
        serialized = json.dumps(clipped, default=str)
    except Exception:
        return _clip(repr(obj), limit)
    if len(serialized) > limit * 2:
        return serialized[: limit * 2]
    return clipped


def _clip_leaves(obj, limit: int):
    if isinstance(obj, str):
        return _clip(obj, limit)
    if isinstance(obj, dict):
        return {k: _clip_leaves(v, limit) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_clip_leaves(v, limit) for v in obj[:200]]
    return obj


class RunTracer:
    def __init__(self, client, run_id: str, session_id: str, metadata: dict):
        self._client = client            # None => inert
        self._trace_id = lc.deterministic_trace_id(run_id)
        self._run_id = run_id
        self._session_id = session_id
        self._metadata = metadata

    @classmethod
    def start(cls, run_id: str, session_id: Optional[str] = None,
              metadata: Optional[dict] = None, name: Optional[str] = None,
              input_text: Optional[str] = None) -> "RunTracer":
        client = lc.LangfuseHTTP.from_env() if lc.enabled() else None
        if lc.enabled() and client is None:
            _log.warning("AGENTRAIL_LANGFUSE_ENABLED set but LANGFUSE_* keys missing; "
                         "tracing disabled for this run")
        tracer = cls(client, run_id, session_id or run_id, metadata or {})
        # `name or "agentrail-run:<run_id>"` preserves the exact prior default
        # when no readable name is supplied; `input` is pruned when absent so
        # the emitted body stays byte-identical to the pre-I/O behavior.
        tracer._safe_emit("trace-create", lambda: _prune({
            "id": tracer._trace_id,
            "name": name or f"agentrail-run:{run_id}",
            "sessionId": tracer._session_id,
            "input": _clip(input_text) if input_text is not None else None,
            "metadata": {"run_id": run_id, **tracer._metadata},
            "tags": ["agentrail"],
        }))
        return tracer

    def phase_generation(self, phase: str, usage: dict, cost_usd: float,
                         breakdown: Optional[dict], start_ts: Optional[float],
                         model: Optional[str]) -> None:
        def build() -> dict:
            # Langfuse's ingestion schema documents costDetails as "USD cost
            # per usage type" — every value a number (see
            # https://langfuse.com/docs/observability/features/token-and-cost-tracking,
            # confirmed 2026-07-20). agentrail.run.pricing.cost_breakdown()
            # gained a non-numeric "price_source" key (#1337 PR②: "gateway" |
            # "price_table" | None) alongside its numeric *_usd components —
            # forwarding that key verbatim here would put a string/None
            # inside a field Langfuse expects to be all-numeric, risking a
            # rejected/malformed generation-create body that _safe_emit would
            # then silently swallow (exactly the failure mode this module's
            # own docstring already warns about). Filter to numeric values
            # only; a non-numeric breakdown field simply never reaches
            # costDetails, it isn't lost — it's still on the breakdown dict
            # the caller (pipeline.py) has directly, for its own use.
            cost_details = {
                k: v for k, v in (breakdown or {}).items() if isinstance(v, (int, float))
            }
            cost_details["total"] = cost_usd
            return {
                "id": str(uuid.uuid4()),
                "traceId": self._trace_id,
                "name": phase,
                "model": model,
                # `is not None`, not truthiness: start_ts=0.0 is a valid Unix
                # epoch (1970-01-01Z), not "unset" — a bare `if start_ts`
                # would silently record _now_iso() instead.
                "startTime": _ts_iso(start_ts) if start_ts is not None else _now_iso(),
                "endTime": _now_iso(),
                "usageDetails": usage,
                "costDetails": cost_details,
            }
        self._safe_emit("generation-create", build)

    def finish(self, exit_status: int, output=None) -> None:
        # Trace-create ingestion merges at the field level (a later event's
        # field fully replaces the prior value, no deep-merge of nested
        # dicts) — resend the full metadata state set at start() plus the
        # new exit_status field, so this upsert never clobbers it. `output`
        # is size-bounded and pruned when absent (so an omitted output never
        # sends a literal null that would wipe a value).
        self._safe_emit("trace-create", lambda: _prune({   # trace upsert: same id, new fields
            "id": self._trace_id,
            "metadata": {"run_id": self._run_id, **self._metadata, "exit_status": exit_status},
            "output": _clip_json(output) if output is not None else None,
        }))

    def _event(self, etype: str, body: dict) -> dict:
        return {"id": str(uuid.uuid4()), "type": etype,
                "timestamp": _now_iso(), "body": body}

    def _safe_emit(self, etype: str, body_fn) -> None:
        """Build one event and ingest it. Inert (no-op) when disabled.

        Body construction happens INSIDE this guarded call, not by the
        caller before invoking it — otherwise malformed inputs (e.g. a NaN
        start_ts) would raise before this method is ever reached, even when
        the tracer is disabled. Nothing here ever propagates.
        """
        if self._client is None:
            return
        try:
            self._client.ingest([self._event(etype, body_fn())])
        except Exception as exc:
            _log.warning("langfuse %s failed (run continues): %s", etype, exc)

"""Per-run Langfuse tracer. Inert unless AGENTRAIL_LANGFUSE_ENABLED and env keys set.

Every public method is non-fatal by construction: a Langfuse outage or
misconfiguration must never affect a run (mirrors the cost block's contract
at agentrail/run/pipeline.py:523-544). This includes malformed inputs (e.g. a
NaN timestamp) — event-body construction happens inside the same guarded path
as the network call, so no public method can ever raise regardless of what is
passed in or what the transport does.

Field names verified against Langfuse API ingestion schema:
  trace-create body: id, sessionId, name, metadata, tags
  generation-create body: traceId, name, model, startTime, endTime, usageDetails, costDetails
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
        tracer._safe_emit("trace-create", lambda: {
            "id": tracer._trace_id,
            "name": f"agentrail-run:{run_id}",
            "sessionId": tracer._session_id,
            "metadata": {"run_id": run_id, **tracer._metadata},
            "tags": ["agentrail"],
        })
        return tracer

    def phase_generation(self, phase: str, usage: dict, cost_usd: float,
                         breakdown: Optional[dict], start_ts: float,
                         model: Optional[str]) -> None:
        def build() -> dict:
            cost_details = dict(breakdown) if breakdown else {}
            cost_details["total"] = cost_usd
            return {
                "traceId": self._trace_id,
                "name": phase,
                "model": model,
                "startTime": _ts_iso(start_ts) if start_ts else _now_iso(),
                "endTime": _now_iso(),
                "usageDetails": usage,
                "costDetails": cost_details,
            }
        self._safe_emit("generation-create", build)

    def finish(self, exit_status: int) -> None:
        # Trace-create ingestion merges at the field level (a later event's
        # field fully replaces the prior value, no deep-merge of nested
        # dicts) — resend the full metadata state set at start() plus the
        # new exit_status field, so this upsert never clobbers it.
        self._safe_emit("trace-create", lambda: {   # trace upsert: same id, new fields
            "id": self._trace_id,
            "metadata": {"run_id": self._run_id, **self._metadata, "exit_status": exit_status},
        })

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

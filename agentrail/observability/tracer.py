"""Per-run Langfuse tracer. Inert unless AGENTRAIL_LANGFUSE_ENABLED and env keys set.

Every public method is non-fatal by construction: a Langfuse outage or
misconfiguration must never affect a run (mirrors the cost block's contract
at agentrail/run/pipeline.py:523-544).

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

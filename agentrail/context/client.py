"""Transparent daemon client with cold-path fallback for context retrieval.

``_resolve_context_client(target)`` returns either a ``_WarmClient`` (when a
daemon socket is live and answers a ping within 100 ms) or a ``_ColdClient``
(always-silent fallback to retrieval.py functions).

Callers never need to check which client they received — method signatures and
return types are identical.  The ``mode`` attribute (``"warm"`` / ``"cold"``) is
available as a benchmark-detectable metadata field without changing the output
shape of any CLI command.

Wire protocol (warm path):
  request:  {"method": "<name>", "params": {...}}
  response: {"result": <value>}

Method names: query, search, def, callers, callees, impact, ping.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from agentrail.context import daemon as _daemon_mod
from agentrail.context.config import read_context_config
from agentrail.context.retrieval import (
    context_callers,
    context_callees,
    context_def,
    context_impact,
    query_context,
    search_context,
)


class _ColdClient:
    """Proxies retrieval calls directly to agentrail.context.retrieval."""

    mode = "cold"

    def __init__(self, target: Path) -> None:
        self._target = target

    def query(self, query: str, limit: int = 20) -> dict[str, Any]:
        return query_context(self._target, query, limit=limit)

    def search(self, query: str, limit: int = 10) -> dict[str, Any]:
        return search_context(self._target, query, limit=limit)

    def def_(self, name: str) -> list[dict[str, Any]]:
        return context_def(self._target, name)

    def callers(self, name: str) -> list[dict[str, Any]]:
        return context_callers(self._target, name)

    def callees(self, name: str) -> list[dict[str, Any]]:
        return context_callees(self._target, name)

    def impact(self, name: str, depth: int = 3) -> list[dict[str, Any]]:
        return context_impact(self._target, name, depth=depth)


class _WarmClient:
    """Proxies retrieval calls to the daemon via RPC."""

    mode = "warm"

    def __init__(self, target: Path, socket_path: Path) -> None:
        self._target = target
        self._socket_path = socket_path

    def _call(self, method: str, params: dict[str, Any] | None = None) -> Any:
        resp = _daemon_mod.rpc(self._socket_path, method, params=params, timeout=5.0)
        return resp.get("result")

    def query(self, query: str, limit: int = 20) -> dict[str, Any]:
        return self._call("query", {"query": query, "limit": limit})

    def search(self, query: str, limit: int = 10) -> dict[str, Any]:
        return self._call("search", {"query": query, "limit": limit})

    def def_(self, name: str) -> list[dict[str, Any]]:
        return self._call("def", {"name": name})

    def callers(self, name: str) -> list[dict[str, Any]]:
        return self._call("callers", {"name": name})

    def callees(self, name: str) -> list[dict[str, Any]]:
        return self._call("callees", {"name": name})

    def impact(self, name: str, depth: int = 3) -> list[dict[str, Any]]:
        return self._call("impact", {"name": name, "depth": depth})


def _resolve_context_client(target: Path) -> _WarmClient | _ColdClient:
    """Return a warm daemon client if available, otherwise a silent cold client.

    The warm path is chosen when the daemon socket file exists and a ping RPC
    (100 ms timeout) succeeds.  On any failure — socket absent, connection
    refused, timeout, malformed JSON — the cold client is returned without
    printing anything to stdout or stderr.
    """
    try:
        socket_path = _daemon_mod.socket_path_for(target)
        if not socket_path.exists():
            try:
                if read_context_config(target).daemonAutoSpawn:
                    _daemon_mod.start_detached(target)
            except Exception:
                pass
            return _ColdClient(target)
        _daemon_mod.rpc(socket_path, "ping", timeout=0.1)
        return _WarmClient(target, socket_path)
    except Exception:
        try:
            if read_context_config(target).daemonAutoSpawn:
                _daemon_mod.start_detached(target)
        except Exception:
            pass
        return _ColdClient(target)

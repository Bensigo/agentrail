"""CI adapter — produces the ``ci_checks`` slice of
:class:`~agentrail.guardrails.signals.Signals` (issue #919).

CI state comes from the host's checks API (e.g. ``gh pr checks`` / the GitHub
checks API).  This adapter is the only place that I/O is allowed to live (AC4);
policies read the resulting :class:`~agentrail.guardrails.signals.CiCheck` tuple
and never call ``gh``.

The #919 slice proves the seam on ``verify_gate`` (which is git-driven), so the CI
adapter ships as a thin, best-effort reader: given an already-fetched payload it
normalises to neutral :class:`CiCheck` objects, and the live ``gh`` fetch is a
best-effort helper that returns ``()`` when the CLI is unavailable.  #920 (unified
objective gate) wires the live fetch into the gate; until then nothing breaks if
``gh`` is absent.
"""
from __future__ import annotations

import json
import subprocess
from typing import Iterable, List, Mapping, Optional, Tuple

from agentrail.guardrails.signals import CiCheck


def checks_from_payload(payload: Iterable[Mapping[str, object]]) -> Tuple[CiCheck, ...]:
    """Normalise an iterable of ``{name, conclusion}`` mappings to ``CiCheck``s.

    Pure parsing — accepts whatever the fetch produced (GitHub's ``name`` +
    ``conclusion``/``state``/``status`` shapes) and yields neutral objects.
    """
    out: List[CiCheck] = []
    for item in payload:
        name = str(item.get("name") or item.get("context") or "")
        conclusion = str(
            item.get("conclusion")
            or item.get("state")
            or item.get("status")
            or ""
        )
        if name:
            out.append(CiCheck(name=name, conclusion=conclusion))
    return tuple(out)


def fetch_ci_checks(ref: Optional[str] = None) -> Tuple[CiCheck, ...]:
    """Best-effort live fetch of CI checks via the ``gh`` CLI.

    Returns ``()`` when ``gh`` is unavailable or errors — the gate must still run.
    """
    args = ["gh", "pr", "checks", "--json", "name,state,conclusion"]
    if ref:
        args.append(ref)
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=30)
    except Exception:
        return ()
    if proc.returncode != 0 or not proc.stdout.strip():
        return ()
    try:
        payload = json.loads(proc.stdout)
    except Exception:
        return ()
    if not isinstance(payload, list):
        return ()
    return checks_from_payload(payload)


__all__ = ["checks_from_payload", "fetch_ci_checks"]

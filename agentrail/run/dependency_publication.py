"""Compatibility entry point for dependency PR publication.

The canonical publication contract lives with the dependency domain. The run
harness keeps this import path because the native runner is part of the run
surface and existing callers import it from here.
"""
from __future__ import annotations

from typing import Any, Mapping, Optional

from agentrail.dependencies.publication import (
    build_dependency_pr_body as _build_dependency_pr_body,
    evaluate_dependency_publication,
    is_dependency_publication,
)


def dependency_publication_failure(data: Mapping[str, Any]) -> Optional[str]:
    """Return all fail-closed publication blockers, or ``None``."""
    if not is_dependency_publication(data):
        return None
    decision = evaluate_dependency_publication(data)
    return "; ".join(decision.reasons) if not decision.allowed else None


def build_dependency_pr_body(data: Mapping[str, Any], *, issue_ref: str = "") -> str:
    """Build the server-owned PR body from the canonical decision."""
    decision = evaluate_dependency_publication(data)
    if not decision.allowed:
        raise ValueError("; ".join(decision.reasons))
    return _build_dependency_pr_body(decision, issue_ref=issue_ref)


__all__ = ["build_dependency_pr_body", "dependency_publication_failure"]

"""Backwards-compatible shim — the GitHub client now lives in ``connectors``.

The single GitHub client was consolidated into
``agentrail/connectors/github.py`` behind the shared Connector interface
(M038, verification-contract-architecture.md: "Connectors consolidate
``afk/github.py`` … do not add a second GitHub client"). This module re-exports
those primitives so existing AFK callers (``afk/runner.py``,
``cli/commands/afk.py``, the dependency-queue tests) keep working unchanged.

New code should import from ``agentrail.connectors.github`` directly.
"""
from __future__ import annotations

from agentrail.connectors.github import (  # noqa: F401
    _BLOCKED_BY_SECTION,
    _run,
    add_issue_label,
    add_pr_label,
    comment_on_issue,
    comment_on_pr,
    detect_pr_for_issue,
    ensure_label,
    issue_body,
    list_queue_issues,
    merge_pr_squash,
    open_issue_numbers,
    parse_blocked_by,
    pr_head_ref,
    pr_state,
    remove_issue_label,
)

__all__ = [
    "add_issue_label",
    "add_pr_label",
    "comment_on_issue",
    "comment_on_pr",
    "detect_pr_for_issue",
    "ensure_label",
    "issue_body",
    "list_queue_issues",
    "merge_pr_squash",
    "open_issue_numbers",
    "parse_blocked_by",
    "pr_head_ref",
    "pr_state",
    "remove_issue_label",
]

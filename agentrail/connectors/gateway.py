"""Gateway dispatch — fan-out terminal run-outcome notifications to all enabled
gateway connectors (Telegram, Slack, Discord, or any Connector with notify).

``notify_run_outcome`` is the single call-site the runner result path uses.
Best-effort: one connector failing never blocks the others and never alters the
recorded run result (AC3).
"""
from __future__ import annotations

from typing import Sequence

from agentrail.connectors.base import ConnectorEvent

# The three terminal Run-Outcome states (CONTEXT.md vocabulary).
_TERMINAL_OUTCOMES = frozenset({"green", "escalated-to-human", "blocked"})

# Map terminal outcome → ConnectorEvent kind (reuses existing gateway vocabulary).
_OUTCOME_TO_KIND = {
    "green": "completed",
    "escalated-to-human": "escalated",
    "blocked": "blocked",
}


def notify_run_outcome(
    connectors: Sequence,
    *,
    issue_number: int,
    outcome: str,
    pr_url: str = "",
) -> None:
    """Fan-out a terminal run-outcome notification to all gateway connectors.

    Non-terminal outcomes (e.g. ``"running"``) are a no-op (AC4).  Each
    connector's ``notify`` is called independently; exceptions are swallowed so
    a failing gateway never changes the recorded run result (AC3).

    Args:
        connectors:   Enabled gateway connectors for the workspace (AC5 —
                      any Connector whose ``notify`` is callable).
        issue_number: The issue ref surfaced in the notification (AC1).
        outcome:      Run-Outcome terminal state — ``"green"`` /
                      ``"escalated-to-human"`` / ``"blocked"``.
        pr_url:       Optional PR or branch URL included in the detail (AC1).
    """
    if outcome not in _TERMINAL_OUTCOMES:
        return None
    kind = _OUTCOME_TO_KIND.get(outcome, outcome)
    event = ConnectorEvent(kind=kind, issue_number=issue_number, detail=pr_url)
    for connector in connectors:
        try:
            connector.notify(event)
        except Exception:  # best-effort — never a gate (AC3)
            pass
    return None

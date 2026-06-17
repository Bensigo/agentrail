"""Slack connector — a **notify** gateway adapter (M038 catalog expansion).

Slack is one of the three *gateway* channels (Discord, Slack, Telegram): an
outbound-only surface that posts a run's terminal **Run Outcome** to a Slack
channel via an **incoming webhook**
(``https://hooks.slack.com/services/…``). Like the Discord adapter it implements
only ``notify`` of the shared :class:`~agentrail.connectors.base.Connector`
contract — it never *ingests* work and has no source issue to post *back* on
(GitHub owns ingest + the issue back-channel).

It mirrors Discord exactly, only the wire payload differs: Slack's incoming
webhook takes ``{"text": …}``. Stdlib-only (``urllib``, no Slack SDK); the HTTP is
injectable via ``transport`` so tests assert the posted payload with no live
network. An unconfigured connector (no ``webhook_url``) and any transport blip are
safe no-ops — a missing channel must never wedge a run.

The shared data type (:class:`~agentrail.connectors.discord.TaskResult`) and the
pure digest builder (:func:`~agentrail.connectors.discord.build_daily_digest`)
are reused so every gateway speaks one Run-Outcome vocabulary.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Callable, List, Optional, Sequence

from agentrail.connectors.base import (
    Connector,
    ConnectorEvent,
    IngestedIssue,
    OutcomeReport,
)
from agentrail.connectors.discord import (
    TaskResult,
    build_daily_digest,
    _KIND_HEADLINE,
    _KIND_TO_OUTCOME,
    _fmt_cost,
)

# A transport posts a JSON payload to a webhook URL and returns the HTTP status.
# Injectable so tests capture the call instead of touching the network.
Transport = Callable[[str, dict], int]


def _urllib_transport(url: str, payload: dict) -> int:
    """Default transport: POST the JSON payload to the Slack webhook via urllib."""
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:  # nosec - configured webhook
        return getattr(resp, "status", 0) or 0


def _render_event(event: ConnectorEvent, outcome: str) -> str:
    """Render the one-line channel message (Run-Outcome vocabulary)."""
    headline = _KIND_HEADLINE.get(event.kind, event.kind)
    line = f"AgentRail: {headline} — issue #{event.issue_number} ({outcome})"
    if event.detail:
        line = f"{line}\n{event.detail}"
    return line


def _render_task_done(result: TaskResult) -> str:
    """Render the concise per-task update (Run-Outcome vocabulary)."""
    line = f"AgentRail: #{result.number} {result.title} — {result.state}"
    extras = []
    cost = _fmt_cost(result.cost_usd)
    if cost:
        extras.append(cost)
    if result.url:
        extras.append(result.url)
    if extras:
        line = f"{line} ({' · '.join(extras)})"
    return line


class SlackConnector(Connector):
    """Slack notify adapter for the shared connector contract (gateway).

    A run's terminal outcome becomes a one-line channel message posted to the
    incoming webhook. ``transport`` is injectable so tests assert the payload.
    """

    def __init__(
        self,
        *,
        webhook_url: Optional[str] = None,
        transport: Optional[Transport] = None,
    ) -> None:
        self.webhook_url = webhook_url
        self._transport: Transport = transport or _urllib_transport

    # -- the shared Connector surface ------------------------------------- #
    def ingest(self) -> List[IngestedIssue]:
        """Not applicable: Slack is outbound-only, not an issue source."""
        return []

    def post_result(self, issue_ref: int, outcome: OutcomeReport) -> None:
        """Not applicable: Slack has no source issue to comment back on."""
        return None

    def notify(self, event: ConnectorEvent) -> None:
        """Post a channel notification for a surfaced terminal (completed/escalated).

        Unconfigured (no webhook) or a non-surfaced kind is a safe no-op; a
        transport error is swallowed — a notification is best-effort, not a gate.
        """
        outcome = _KIND_TO_OUTCOME.get(event.kind)
        if outcome is None or not self.webhook_url:
            return None
        try:
            self._transport(self.webhook_url, {"text": _render_event(event, outcome)})
        except (urllib.error.URLError, OSError):
            return None
        return None

    @staticmethod
    def event_from_outcome(issue_ref: int, outcome: OutcomeReport) -> ConnectorEvent:
        """Map a terminal :class:`OutcomeReport` to the event ``notify`` expects."""
        from agentrail.afk.queue_state import Terminal

        state = (outcome.state or "").lower()
        kind = "escalated" if state == Terminal.ESCALATED_TO_HUMAN.value else "completed"
        return ConnectorEvent(kind=kind, issue_number=issue_ref, detail=outcome.summary)


def _post(webhook_url: Optional[str], text: str, transport: Transport) -> None:
    """Best-effort POST of a channel message. Unconfigured/blip → safe no-op."""
    if not webhook_url:
        return None
    try:
        transport(webhook_url, {"text": text})
    except (urllib.error.URLError, OSError):
        return None
    return None


def notify_task_done(
    *,
    webhook_url: Optional[str],
    result: TaskResult,
    transport: Optional[Transport] = None,
) -> None:
    """Post a concise per-task update when a run finishes. Unconfigured → no-op."""
    _post(webhook_url, _render_task_done(result), transport or _urllib_transport)
    return None


def notify_daily_digest(
    *,
    webhook_url: Optional[str],
    finished: Sequence[TaskResult],
    transport: Optional[Transport] = None,
) -> None:
    """Post the daily digest, or nothing on an empty day (no spam)."""
    text = build_daily_digest(finished)
    if text is None:
        return None
    _post(webhook_url, text, transport or _urllib_transport)
    return None

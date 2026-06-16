"""Discord connector — a **notify** adapter behind ``connectors/base.py`` (M038).

Discord is the channel-notification half of the two-way connector contract
(CONTEXT.md, ADR 0010): it does not *ingest* work and it has no source issue to
post a result *back* on — it surfaces a run's terminal **Run Outcome** on a
configured Discord channel. So of the shared :class:`~agentrail.connectors.base.Connector`
surface, only ``notify`` does anything here; ``ingest`` and ``post_result`` are
explicit not-applicable no-ops (GitHub owns ingest + the issue back-channel).

The two notifications the issue asks for map onto the **Run Outcome** terminals
in ``agentrail/afk/queue_state.py`` — no new vocabulary:

- **completion** == :attr:`~agentrail.afk.queue_state.Terminal.GREEN` ("green").
- **escalation** == :attr:`~agentrail.afk.queue_state.Terminal.ESCALATED_TO_HUMAN`
  ("escalated-to-human").

Like the GitHub adapter, this is stdlib-only — the webhook POST goes through
``urllib`` (no ``discord`` SDK). The HTTP is injectable via ``transport`` so the
integration tests run against a mock with no live network. An unconfigured
connector (no ``webhook_url``) is a safe no-op: a missing channel must never wedge
a run or raise.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Callable, List, Optional

from agentrail.afk.queue_state import Terminal
from agentrail.connectors.base import (
    Connector,
    ConnectorEvent,
    IngestedIssue,
    OutcomeReport,
)

# A transport posts a JSON payload to a webhook URL and returns the HTTP status.
# Injectable so tests capture the call instead of touching the network.
Transport = Callable[[str, dict], int]

# Map the lifecycle event ``kind`` we surface to its Run-Outcome wording. Only
# the two terminals the issue asks for are notified; other kinds are ignored.
_KIND_TO_OUTCOME = {
    "completed": Terminal.GREEN.value,            # "green"
    "escalated": Terminal.ESCALATED_TO_HUMAN.value,  # "escalated-to-human"
}

# A short, scannable headline per surfaced terminal (TASTE.md: direct, no hype).
_KIND_HEADLINE = {
    "completed": "Run completed",
    "escalated": "Escalated to human",
}


def completion_event(issue_number: int, detail: str = "") -> ConnectorEvent:
    """A COMPLETION lifecycle event (Run Outcome **green**) for ``notify`` (AC1)."""
    return ConnectorEvent(kind="completed", issue_number=issue_number, detail=detail)


def escalation_event(issue_number: int, detail: str = "") -> ConnectorEvent:
    """An ESCALATION-to-human lifecycle event (Run Outcome **escalated-to-human**) (AC2)."""
    return ConnectorEvent(kind="escalated", issue_number=issue_number, detail=detail)


def _urllib_transport(url: str, payload: dict) -> int:
    """Default transport: POST the JSON payload to the webhook via stdlib urllib.

    Mirrors the github adapter's "stdlib only, no SDK" rule. Returns the HTTP
    status; raises on a transport error so the caller's guard can swallow it.
    """
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:  # nosec - configured webhook
        return getattr(resp, "status", 0) or 0


class DiscordConnector(Connector):
    """Discord notify adapter for the shared connector contract (M038, AC1/AC2).

    A run's terminal outcome becomes a one-line channel message. The connector is
    bound to a single webhook (``webhook_url``); ``transport`` is injectable so
    tests assert the posted payload without a live network call.
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
        """Not applicable: Discord is outbound-only, not an issue source."""
        return []

    def post_result(self, issue_ref: int, outcome: OutcomeReport) -> None:
        """Not applicable: Discord has no source issue to comment back on.

        The issue back-channel is GitHub's ``post_result`` (a comment on the
        issue). Discord surfaces the same outcome as a channel *notification* via
        :meth:`notify`; posting here would be a misleading second channel, so this
        is an explicit no-op.
        """
        return None

    def notify(self, event: ConnectorEvent) -> None:
        """Post a channel notification for a surfaced terminal (AC1/AC2).

        Only the two Run-Outcome terminals the issue asks for are surfaced:
        ``completed`` (green) and ``escalated`` (escalated-to-human). Any other
        lifecycle kind, or an unconfigured connector (no webhook), is a safe
        no-op — a missing channel never wedges a run. A transport error is
        swallowed for the same reason: a notification is best-effort, not a gate.
        """
        outcome = _KIND_TO_OUTCOME.get(event.kind)
        if outcome is None or not self.webhook_url:
            return None
        payload = {"content": self._render(event, outcome)}
        try:
            self._transport(self.webhook_url, payload)
        except (urllib.error.URLError, OSError):
            # Best-effort: a webhook blip must not fail the run.
            return None
        return None

    # -- helpers ----------------------------------------------------------- #
    @staticmethod
    def event_from_outcome(
        issue_ref: int, outcome: OutcomeReport
    ) -> ConnectorEvent:
        """Map a terminal :class:`OutcomeReport` to the event ``notify`` expects.

        ``green`` → a completion event; ``escalated-to-human`` → an escalation
        event. Lets a caller hand the connector the same ``OutcomeReport`` it
        gives the GitHub back-channel and get the right notification.
        """
        state = (outcome.state or "").lower()
        if state == Terminal.ESCALATED_TO_HUMAN.value:
            return escalation_event(issue_ref, detail=outcome.summary)
        # Default to completion for green (and anything else terminal-ish that a
        # caller routes here as a positive outcome).
        return completion_event(issue_ref, detail=outcome.summary)

    @staticmethod
    def _render(event: ConnectorEvent, outcome: str) -> str:
        """Render the one-line channel message (Run-Outcome vocabulary)."""
        headline = _KIND_HEADLINE.get(event.kind, event.kind)
        line = f"AgentRail: {headline} — issue #{event.issue_number} ({outcome})"
        if event.detail:
            line = f"{line}\n{event.detail}"
        return line

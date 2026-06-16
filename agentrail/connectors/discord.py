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

**Adam** (MVP, outbound only) extends this same channel surface with two
dispatcher-called seams: :func:`notify_task_done` posts a concise per-task update
when a run finishes, and :func:`build_daily_digest` / :func:`notify_daily_digest`
post a once-a-day summary of what happened — or nothing on an empty day (no spam).
They reuse the same injectable stdlib ``Transport`` and the same Run-Outcome
vocabulary; there is no command intake yet.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Callable, List, Optional, Sequence

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


# --------------------------------------------------------------------------- #
# Adam — outbound Discord updates (MVP).
#
# Adam is the outbound-only half of the Discord channel surface: when a task (an
# Issue Queue run) reaches a **Run Outcome** terminal it posts a concise per-task
# update, and once a day it posts a digest summarizing what happened — if anything
# did. There is no command intake yet (outbound only). These are module-level
# *seams* the run dispatcher calls; the webhook HTTP stays the same injectable
# stdlib ``Transport`` the connector uses, so tests run with no live network.
# --------------------------------------------------------------------------- #

# How each **Run Outcome** terminal buckets in the daily digest, matching the
# Heartbeat cadence's triage wording (green→merged-ish, escalated, blocked→failed)
# but kept in Run-Outcome vocabulary so the channel speaks one language.
_DIGEST_BUCKETS = (
    (Terminal.GREEN.value, "green"),
    (Terminal.ESCALATED_TO_HUMAN.value, "escalated"),
    (Terminal.BLOCKED.value, "failed"),
)


@dataclass(frozen=True)
class TaskResult:
    """One finished task (Issue Queue run) the dispatcher hands to Adam.

    ``state`` is the Run-Outcome wording (``green`` / ``escalated-to-human`` /
    ``blocked``). ``url`` is the branch/PR link if the run produced one; ``cost_usd``
    is the run's real-dollar cost. These are exactly the fields a per-task update
    and the daily digest surface.
    """

    number: int
    title: str
    state: str
    cost_usd: Optional[float] = None
    url: str = ""

    @property
    def bucket(self) -> str:
        """The digest bucket label for this result's terminal (green/escalated/failed)."""
        for value, label in _DIGEST_BUCKETS:
            if self.state == value:
                return label
        return "failed"  # any unknown/blocked-ish terminal is treated as failed


def _post(webhook_url: Optional[str], content: str, transport: Transport) -> None:
    """Best-effort POST of a channel message. Unconfigured/blip → safe no-op.

    Mirrors :meth:`DiscordConnector.notify`: a missing webhook never wedges a run,
    and a transport error is swallowed — a notification is best-effort, not a gate.
    """
    if not webhook_url:
        return None
    try:
        transport(webhook_url, {"content": content})
    except (urllib.error.URLError, OSError):
        return None
    return None


def _fmt_cost(cost_usd: Optional[float]) -> str:
    """Render a run cost as ``$0.14`` (two decimals), or empty when unknown."""
    if cost_usd is None:
        return ""
    return f"${cost_usd:.2f}"


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


def notify_task_done(
    *,
    webhook_url: Optional[str],
    result: TaskResult,
    transport: Optional[Transport] = None,
) -> None:
    """Post a concise per-task update when a run finishes (AC1).

    Surfaces the issue ref/title, the Run-Outcome terminal (green / escalated /
    blocked), the run cost, and the branch/PR link if any. An unconfigured channel
    (no ``webhook_url``) is a safe no-op — a missing channel never wedges a run.
    """
    _post(webhook_url, _render_task_done(result), transport or _urllib_transport)
    return None


def build_daily_digest(finished: Sequence[TaskResult]) -> Optional[str]:
    """Summarize the day's finished tasks (AC2/AC3). Pure.

    Buckets each result by its **Run Outcome** terminal into green / escalated /
    failed, with counts and a short per-issue list. Returns ``None`` for an empty
    day so the caller posts nothing (AC3, no spam).
    """
    if not finished:
        return None

    buckets: dict[str, List[TaskResult]] = {"green": [], "escalated": [], "failed": []}
    for result in finished:
        buckets[result.bucket].append(result)

    lines = [f"AgentRail daily digest — {len(finished)} finished"]
    for _value, label in _DIGEST_BUCKETS:
        items = buckets[label]
        if not items:
            lines.append(f"- {label}: 0")
            continue
        refs = ", ".join(f"#{r.number} {r.title}" for r in items)
        lines.append(f"- {label}: {len(items)} — {refs}")
    return "\n".join(lines)


def notify_daily_digest(
    *,
    webhook_url: Optional[str],
    finished: Sequence[TaskResult],
    transport: Optional[Transport] = None,
) -> None:
    """Post the daily digest, or nothing on an empty day (AC2/AC3).

    Builds the digest via :func:`build_daily_digest`; when the day is empty the
    digest is ``None`` and nothing is posted (no spam). An unconfigured channel is
    also a safe no-op.
    """
    text = build_daily_digest(finished)
    if text is None:
        return None
    _post(webhook_url, text, transport or _urllib_transport)
    return None

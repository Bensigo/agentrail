"""Telegram connector — a **notify** gateway adapter (M038 catalog expansion).

Telegram is the third *gateway* channel (with Discord and Slack): an outbound-only
surface that posts a run's terminal **Run Outcome** to a Telegram chat via a
**bot**. It authenticates with a BotFather token and targets a ``chat_id`` (a
numeric id or ``@channel``), calling the Bot API's ``sendMessage`` method —
``https://api.telegram.org/bot<token>/sendMessage`` with ``{"chat_id", "text"}``.

Like the other gateways it implements only ``notify`` of the shared
:class:`~agentrail.connectors.base.Connector` contract; it never *ingests* work and
has no source issue to post *back* on. Stdlib-only (``urllib``, no Telegram SDK);
the HTTP is injectable via ``transport`` so tests assert the posted payload with no
live network. An unconfigured connector (missing token or chat id) and any
transport blip are safe no-ops — a missing channel must never wedge a run. The
shared :class:`~agentrail.connectors.discord.TaskResult` + the pure
:func:`~agentrail.connectors.discord.build_daily_digest` are reused so every
gateway speaks one Run-Outcome vocabulary.
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

# A transport posts a JSON payload to a fully-built URL and returns the HTTP
# status. Injectable so tests capture the call instead of touching the network.
Transport = Callable[[str, dict], int]


def _send_message_url(token: str) -> str:
    """The Bot API sendMessage endpoint for ``token`` (no secret leaks in logs)."""
    return f"https://api.telegram.org/bot{token}/sendMessage"


def _urllib_transport(url: str, payload: dict) -> int:
    """Default transport: POST the JSON payload to the Bot API via urllib."""
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:  # nosec - configured bot
        return getattr(resp, "status", 0) or 0


def _render_event(event: ConnectorEvent, outcome: str) -> str:
    """Render the one-line chat message (Run-Outcome vocabulary)."""
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


class TelegramConnector(Connector):
    """Telegram notify adapter for the shared connector contract (gateway).

    Bound to a bot ``token`` + target ``chat_id``; ``transport`` is injectable so
    tests assert the posted payload without a live network call.
    """

    def __init__(
        self,
        *,
        token: Optional[str] = None,
        chat_id: Optional[str] = None,
        transport: Optional[Transport] = None,
    ) -> None:
        self.token = token
        self.chat_id = chat_id
        self._transport: Transport = transport or _urllib_transport

    # -- the shared Connector surface ------------------------------------- #
    def ingest(self) -> List[IngestedIssue]:
        """Not applicable: Telegram is outbound-only, not an issue source."""
        return []

    def post_result(self, issue_ref: int, outcome: OutcomeReport) -> None:
        """Not applicable: Telegram has no source issue to comment back on."""
        return None

    def notify(self, event: ConnectorEvent) -> None:
        """Post a chat notification for a surfaced terminal (completed/escalated).

        Unconfigured (missing token or chat id) or a non-surfaced kind is a safe
        no-op; a transport error is swallowed — best-effort, not a gate.
        """
        outcome = _KIND_TO_OUTCOME.get(event.kind)
        if outcome is None or not self.token or not self.chat_id:
            return None
        payload = {"chat_id": self.chat_id, "text": _render_event(event, outcome)}
        try:
            self._transport(_send_message_url(self.token), payload)
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


def _post(
    token: Optional[str],
    chat_id: Optional[str],
    text: str,
    transport: Transport,
) -> None:
    """Best-effort sendMessage. Unconfigured (no token/chat)/blip → safe no-op."""
    if not token or not chat_id:
        return None
    try:
        transport(_send_message_url(token), {"chat_id": chat_id, "text": text})
    except (urllib.error.URLError, OSError):
        return None
    return None


def notify_task_done(
    *,
    token: Optional[str],
    chat_id: Optional[str],
    result: TaskResult,
    transport: Optional[Transport] = None,
) -> None:
    """Post a concise per-task update when a run finishes. Unconfigured → no-op."""
    _post(token, chat_id, _render_task_done(result), transport or _urllib_transport)
    return None


_HELP_TEXT = (
    "I understand:\n"
    "  /status — current run/queue snapshot (running, queued, escalated)\n\n"
    "Send /status to see what AgentRail is working on."
)


def _render_snapshot(snap: dict) -> str:
    """Format a workspace snapshot into a concise status reply."""
    running = snap.get("running", 0)
    queued = snap.get("queued", 0)
    escalated = snap.get("escalated", 0)
    lines = [
        f"AgentRail status:",
        f"  Running:   {running}",
        f"  Queued:    {queued}",
        f"  Escalated: {escalated}",
    ]
    issues = snap.get("issues") or []
    running_issues = [i for i in issues if i.get("state") == "running"]
    if running_issues:
        nums = ", ".join(f"#{i['number']}" for i in running_issues)
        lines.append(f"  Active: {nums}")
    queued_issues = [i for i in issues if i.get("state") == "queued"]
    if queued_issues:
        nums = ", ".join(f"#{i['number']}" for i in queued_issues)
        lines.append(f"  Queued: {nums}")
    escalated_issues = [i for i in issues if i.get("state") == "escalated"]
    if escalated_issues:
        nums = ", ".join(f"#{i['number']}" for i in escalated_issues)
        lines.append(f"  Escalated: {nums}")
    return "\n".join(lines)


def handle_inbound_update(
    update: object,
    *,
    token: str,
    chat_id: str,
    get_snapshot: Callable[[], dict],
    transport: Optional[Transport] = None,
) -> None:
    """Handle one Telegram Bot API update object (best-effort, isolated).

    Authorizes the message to the workspace by matching ``chat_id``.  Replies
    to ``/status`` with the run/queue snapshot; replies to anything else with
    a short help message.  An unknown chat id, a malformed update, or any
    exception is a safe no-op — never crashes the receiver.
    """
    _transport = transport or _urllib_transport
    try:
        if not isinstance(update, dict):
            return None
        message = update.get("message")
        if not isinstance(message, dict):
            return None
        chat = message.get("chat")
        if not isinstance(chat, dict):
            return None
        incoming_chat_id = chat.get("id")
        if incoming_chat_id is None:
            return None
        # Normalize to string for comparison (test sends numeric id, config may be string).
        if str(incoming_chat_id) != str(chat_id):
            return None  # AC3: unknown chat — silence
        text = message.get("text") or ""
        text_stripped = text.strip()
        if text_stripped.lower().startswith("/status"):
            snap = get_snapshot()
            reply = _render_snapshot(snap)
        else:
            reply = _HELP_TEXT
        _post(token, chat_id, reply, _transport)
    except Exception:  # noqa: BLE001 — best-effort, never propagate
        return None
    return None


def notify_daily_digest(
    *,
    token: Optional[str],
    chat_id: Optional[str],
    finished: Sequence[TaskResult],
    transport: Optional[Transport] = None,
) -> None:
    """Post the daily digest, or nothing on an empty day (no spam)."""
    text = build_daily_digest(finished)
    if text is None:
        return None
    _post(token, chat_id, text, transport or _urllib_transport)
    return None

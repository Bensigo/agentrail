"""Slack notify-gateway integration tests against a MOCKED incoming webhook.

Slack is a **notify** gateway (M038 catalog expansion): it posts a channel
message when a run reaches a **Run Outcome** terminal. Mirrors the Discord tests,
only the wire payload differs — Slack's incoming webhook takes ``{"text": …}``.
The webhook HTTP is injectable so these never touch the network: a fake transport
captures (url, payload) and we assert the posted body. ``ingest`` / ``post_result``
are not-applicable for an outbound notify connector (explicit no-ops).
"""
from __future__ import annotations

import unittest

from agentrail.connectors.base import ConnectorEvent, OutcomeReport
from agentrail.connectors.discord import (
    TaskResult,
    completion_event,
    escalation_event,
)
from agentrail.connectors.slack import (
    SlackConnector,
    notify_daily_digest,
    notify_task_done,
)


class _FakeTransport:
    """Captures every webhook POST instead of hitting the network."""

    def __init__(self, status: int = 200):
        self.status = status
        self.calls: list[tuple[str, dict]] = []

    def __call__(self, url: str, payload: dict) -> int:
        self.calls.append((url, payload))
        return self.status


_WEBHOOK = "https://hooks.slack.com/services/T0/B0/abcDEF"


class SlackNotifyTests(unittest.TestCase):
    def test_completion_notification_posts_text_payload(self):
        transport = _FakeTransport()
        conn = SlackConnector(webhook_url=_WEBHOOK, transport=transport)
        conn.notify(completion_event(issue_number=42, detail="PR #99 ready"))
        self.assertEqual(len(transport.calls), 1)
        url, payload = transport.calls[0]
        self.assertEqual(url, _WEBHOOK)
        # Slack uses "text", not Discord's "content".
        self.assertIn("text", payload)
        self.assertIn("#42", payload["text"])
        self.assertIn("PR #99 ready", payload["text"])
        self.assertIn("green", payload["text"].lower())

    def test_escalation_notification_posts(self):
        transport = _FakeTransport()
        conn = SlackConnector(webhook_url=_WEBHOOK, transport=transport)
        conn.notify(escalation_event(issue_number=7, detail="budget exhausted"))
        self.assertEqual(len(transport.calls), 1)
        text = transport.calls[0][1]["text"]
        self.assertIn("#7", text)
        self.assertIn("escalated", text.lower())

    def test_unconfigured_is_a_safe_no_op(self):
        transport = _FakeTransport()
        conn = SlackConnector(webhook_url=None, transport=transport)
        conn.notify(completion_event(issue_number=1))
        self.assertEqual(transport.calls, [])

    def test_unknown_kind_is_ignored(self):
        transport = _FakeTransport()
        conn = SlackConnector(webhook_url=_WEBHOOK, transport=transport)
        conn.notify(ConnectorEvent(kind="blocked", issue_number=1))
        self.assertEqual(transport.calls, [])

    def test_transport_error_is_swallowed(self):
        def boom(url, payload):
            raise OSError("network down")

        conn = SlackConnector(webhook_url=_WEBHOOK, transport=boom)
        # Must not raise — a webhook blip never wedges a run.
        conn.notify(completion_event(issue_number=1))

    def test_ingest_and_post_result_are_no_ops(self):
        conn = SlackConnector(webhook_url=_WEBHOOK)
        self.assertEqual(conn.ingest(), [])
        self.assertIsNone(
            conn.post_result(1, OutcomeReport(state="green", summary="x"))
        )

    def test_event_from_outcome_maps_state(self):
        green = SlackConnector.event_from_outcome(
            5, OutcomeReport(state="green", summary="ok")
        )
        esc = SlackConnector.event_from_outcome(
            5, OutcomeReport(state="escalated-to-human", summary="nope")
        )
        self.assertEqual(green.kind, "completed")
        self.assertEqual(esc.kind, "escalated")


class SlackSeamTests(unittest.TestCase):
    def test_notify_task_done_posts_text(self):
        transport = _FakeTransport()
        notify_task_done(
            webhook_url=_WEBHOOK,
            result=TaskResult(number=3, title="Fix bug", state="green", cost_usd=0.14),
            transport=transport,
        )
        self.assertEqual(len(transport.calls), 1)
        text = transport.calls[0][1]["text"]
        self.assertIn("#3", text)
        self.assertIn("Fix bug", text)
        self.assertIn("$0.14", text)

    def test_daily_digest_silent_on_empty_day(self):
        transport = _FakeTransport()
        notify_daily_digest(webhook_url=_WEBHOOK, finished=[], transport=transport)
        self.assertEqual(transport.calls, [])

    def test_daily_digest_posts_summary(self):
        transport = _FakeTransport()
        notify_daily_digest(
            webhook_url=_WEBHOOK,
            finished=[TaskResult(number=1, title="A", state="green")],
            transport=transport,
        )
        self.assertEqual(len(transport.calls), 1)
        self.assertIn("digest", transport.calls[0][1]["text"].lower())


if __name__ == "__main__":
    unittest.main()

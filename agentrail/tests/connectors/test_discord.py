"""Discord notify-connector integration tests against a MOCKED webhook (M038).

Discord is a **notify** connector (verification-contract-architecture.md): it
posts a channel message when a run reaches a **Run Outcome** terminal. The two
the issue asks for:

- AC1 — a **completion** (Run Outcome ``green``) notification is posted.
- AC2 — an **escalation-to-human** (Run Outcome ``escalated-to-human``)
  notification is posted.

The webhook HTTP is injectable so these tests never touch the network: we pass a
fake transport that captures (url, payload) and assert the posted body. ``ingest``
and ``post_result`` are not-applicable for an outbound notify connector and are
covered as explicit no-ops.
"""
from __future__ import annotations

import json
import unittest

from agentrail.connectors.base import ConnectorEvent, OutcomeReport
from agentrail.connectors.discord import (
    DiscordConnector,
    TaskResult,
    build_daily_digest,
    completion_event,
    escalation_event,
    notify_daily_digest,
    notify_task_done,
)


class _FakeTransport:
    """Captures every webhook POST instead of hitting the network."""

    def __init__(self, status: int = 204):
        self.status = status
        self.calls: list[tuple[str, dict]] = []

    def __call__(self, url: str, payload: dict) -> int:
        self.calls.append((url, payload))
        return self.status


_WEBHOOK = "https://discord.com/api/webhooks/123/abc"


class CompletionNotifyTests(unittest.TestCase):
    def test_completion_notification_is_posted_to_the_channel(self):
        # AC1: a COMPLETION (Run Outcome green) notification posts to the webhook.
        transport = _FakeTransport()
        conn = DiscordConnector(webhook_url=_WEBHOOK, transport=transport)

        conn.notify(completion_event(issue_number=42, detail="PR #99 ready"))

        self.assertEqual(len(transport.calls), 1)
        url, payload = transport.calls[0]
        self.assertEqual(url, _WEBHOOK)
        content = payload["content"]
        self.assertIn("#42", content)
        self.assertIn("PR #99 ready", content)
        # Uses the Run-Outcome vocabulary: completion == Green.
        self.assertIn("green", content.lower())

    def test_notify_completed_kind_directly_posts(self):
        # The shared ConnectorEvent vocabulary (kind="completed") also works.
        transport = _FakeTransport()
        conn = DiscordConnector(webhook_url=_WEBHOOK, transport=transport)
        conn.notify(ConnectorEvent(kind="completed", issue_number=7))
        self.assertEqual(len(transport.calls), 1)
        self.assertIn("#7", transport.calls[0][1]["content"])


class EscalationNotifyTests(unittest.TestCase):
    def test_escalation_notification_is_posted_to_the_channel(self):
        # AC2: an ESCALATION-to-human notification posts to the webhook.
        transport = _FakeTransport()
        conn = DiscordConnector(webhook_url=_WEBHOOK, transport=transport)

        conn.notify(
            escalation_event(issue_number=42, detail="budget exhausted")
        )

        self.assertEqual(len(transport.calls), 1)
        url, payload = transport.calls[0]
        self.assertEqual(url, _WEBHOOK)
        content = payload["content"]
        self.assertIn("#42", content)
        self.assertIn("budget exhausted", content)
        # Run-Outcome vocabulary: escalation == escalated-to-human.
        self.assertIn("escalated-to-human", content.lower())


class FromOutcomeTests(unittest.TestCase):
    def test_green_outcome_maps_to_a_completion_event(self):
        ev = DiscordConnector.event_from_outcome(
            42, OutcomeReport(state="green", summary="gate passed")
        )
        self.assertEqual(ev.kind, "completed")
        self.assertEqual(ev.issue_number, 42)
        self.assertIn("gate passed", ev.detail)

    def test_escalated_outcome_maps_to_an_escalation_event(self):
        ev = DiscordConnector.event_from_outcome(
            42, OutcomeReport(state="escalated-to-human", summary="hard stop")
        )
        self.assertEqual(ev.kind, "escalated")
        self.assertEqual(ev.issue_number, 42)


class NotApplicableTests(unittest.TestCase):
    def test_ingest_is_a_noop_returning_empty(self):
        # Discord is outbound-only; it is not an issue source.
        conn = DiscordConnector(webhook_url=_WEBHOOK, transport=_FakeTransport())
        self.assertEqual(conn.ingest(), [])

    def test_post_result_is_a_safe_noop(self):
        transport = _FakeTransport()
        conn = DiscordConnector(webhook_url=_WEBHOOK, transport=transport)
        # post_result is the GitHub back-channel; Discord has no source issue to
        # comment on, so it is a no-op and must not raise or post.
        self.assertIsNone(
            conn.post_result(42, OutcomeReport(state="green", summary="x"))
        )
        self.assertEqual(transport.calls, [])


class UnconfiguredTests(unittest.TestCase):
    def test_notify_without_a_webhook_is_a_safe_noop(self):
        # An unconfigured connector (no webhook) must not raise and must not post.
        transport = _FakeTransport()
        conn = DiscordConnector(webhook_url=None, transport=transport)
        self.assertIsNone(conn.notify(completion_event(issue_number=1)))
        self.assertEqual(transport.calls, [])

    def test_unhandled_event_kind_does_not_post(self):
        # A non-terminal lifecycle kind we do not surface is ignored, not posted.
        transport = _FakeTransport()
        conn = DiscordConnector(webhook_url=_WEBHOOK, transport=transport)
        conn.notify(ConnectorEvent(kind="started", issue_number=1))
        self.assertEqual(transport.calls, [])


class DefaultTransportTests(unittest.TestCase):
    def test_default_transport_uses_urllib_with_json_body(self):
        # No live network: patch urllib.request.urlopen and assert the request
        # shape (stdlib only, like the github adapter — no discord SDK).
        from unittest import mock
        import agentrail.connectors.discord as dmod

        captured = {}

        class _Resp:
            status = 204

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def _fake_urlopen(req, timeout=None):
            captured["url"] = req.full_url
            captured["data"] = req.data
            captured["content_type"] = req.headers.get("Content-type")
            return _Resp()

        with mock.patch.object(dmod.urllib.request, "urlopen", _fake_urlopen):
            conn = DiscordConnector(webhook_url=_WEBHOOK)  # real transport
            conn.notify(completion_event(issue_number=5, detail="done"))

        self.assertEqual(captured["url"], _WEBHOOK)
        body = json.loads(captured["data"].decode("utf-8"))
        self.assertIn("#5", body["content"])
        self.assertEqual(captured["content_type"], "application/json")


class NotifyTaskDoneTests(unittest.TestCase):
    """AC1 — Adam posts a per-task update when a run finishes (mocked webhook)."""

    def test_green_run_posts_concise_update(self):
        # AC1: a green run posts title/ref, outcome, cost, and the PR link.
        transport = _FakeTransport()
        result = TaskResult(
            number=42,
            title="Add Discord digest",
            state="green",
            cost_usd=0.137,
            url="https://github.com/o/r/pull/99",
        )
        notify_task_done(
            webhook_url=_WEBHOOK, result=result, transport=transport
        )

        self.assertEqual(len(transport.calls), 1)
        url, payload = transport.calls[0]
        self.assertEqual(url, _WEBHOOK)
        content = payload["content"]
        self.assertIn("#42", content)
        self.assertIn("Add Discord digest", content)
        self.assertIn("green", content.lower())
        self.assertIn("0.14", content)  # cost rendered to cents
        self.assertIn("https://github.com/o/r/pull/99", content)

    def test_escalated_run_posts_update(self):
        # AC1: an escalated run posts the escalated-to-human outcome.
        transport = _FakeTransport()
        result = TaskResult(
            number=7,
            title="Flaky verifier",
            state="escalated-to-human",
            cost_usd=1.5,
        )
        notify_task_done(
            webhook_url=_WEBHOOK, result=result, transport=transport
        )

        self.assertEqual(len(transport.calls), 1)
        content = transport.calls[0][1]["content"]
        self.assertIn("#7", content)
        self.assertIn("Flaky verifier", content)
        self.assertIn("escalated-to-human", content.lower())

    def test_without_a_webhook_is_a_safe_noop(self):
        transport = _FakeTransport()
        result = TaskResult(number=1, title="x", state="green")
        self.assertIsNone(
            notify_task_done(webhook_url=None, result=result, transport=transport)
        )
        self.assertEqual(transport.calls, [])


class DailyDigestTests(unittest.TestCase):
    """AC2/AC3 — the daily digest buckets terminals and stays silent on empty."""

    def _results(self):
        return [
            TaskResult(number=1, title="Merged A", state="green"),
            TaskResult(number=2, title="Merged B", state="green"),
            TaskResult(number=3, title="Escalated C", state="escalated-to-human"),
            TaskResult(number=4, title="Blocked D", state="blocked"),
        ]

    def test_build_daily_digest_buckets_terminals(self):
        # AC2: counts of green vs escalated vs failed, plus a per-issue list.
        text = build_daily_digest(self._results())
        self.assertIsNotNone(text)
        # Counts present (2 green, 1 escalated, 1 failed/blocked).
        self.assertIn("2", text)
        # Each issue appears in the per-issue list.
        for n in (1, 2, 3, 4):
            self.assertIn(f"#{n}", text)
        # Vocabulary buckets.
        low = text.lower()
        self.assertIn("green", low)
        self.assertIn("escalated", low)
        self.assertIn("failed", low)

    def test_empty_day_builds_nothing(self):
        # AC3: empty day → no digest text (no spam).
        self.assertIsNone(build_daily_digest([]))

    def test_notify_daily_digest_posts(self):
        # AC2: notify_daily_digest posts the built digest to the webhook.
        transport = _FakeTransport()
        notify_daily_digest(
            webhook_url=_WEBHOOK, finished=self._results(), transport=transport
        )
        self.assertEqual(len(transport.calls), 1)
        url, payload = transport.calls[0]
        self.assertEqual(url, _WEBHOOK)
        self.assertIn("#1", payload["content"])

    def test_notify_daily_digest_empty_day_posts_nothing(self):
        # AC3: empty day → no post (no spam).
        transport = _FakeTransport()
        notify_daily_digest(
            webhook_url=_WEBHOOK, finished=[], transport=transport
        )
        self.assertEqual(transport.calls, [])

    def test_notify_daily_digest_without_webhook_is_noop(self):
        transport = _FakeTransport()
        notify_daily_digest(
            webhook_url=None, finished=self._results(), transport=transport
        )
        self.assertEqual(transport.calls, [])


if __name__ == "__main__":
    unittest.main()

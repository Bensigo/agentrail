"""Telegram notify-gateway integration tests against a MOCKED Bot API.

Telegram is a **notify** gateway (M038 catalog expansion): it posts a chat message
via the Bot API ``sendMessage`` when a run reaches a **Run Outcome** terminal. The
HTTP is injectable so these never touch the network: a fake transport captures
(url, payload) and we assert the posted body + that the URL embeds the bot token.
``ingest`` / ``post_result`` are not-applicable (explicit no-ops).
"""
from __future__ import annotations

import unittest

from agentrail.connectors.base import ConnectorEvent, OutcomeReport
from agentrail.connectors.discord import (
    TaskResult,
    completion_event,
    escalation_event,
)
from agentrail.connectors.telegram import (
    TelegramConnector,
    notify_daily_digest,
    notify_task_done,
)


class _FakeTransport:
    def __init__(self, status: int = 200):
        self.status = status
        self.calls: list[tuple[str, dict]] = []

    def __call__(self, url: str, payload: dict) -> int:
        self.calls.append((url, payload))
        return self.status


_TOKEN = "123456789:AAH" + "a" * 32
_CHAT = "-1001234567890"


class TelegramNotifyTests(unittest.TestCase):
    def test_completion_notification_posts_to_send_message(self):
        transport = _FakeTransport()
        conn = TelegramConnector(token=_TOKEN, chat_id=_CHAT, transport=transport)
        conn.notify(completion_event(issue_number=42, detail="PR #99 ready"))
        self.assertEqual(len(transport.calls), 1)
        url, payload = transport.calls[0]
        # The URL embeds the bot token and hits sendMessage.
        self.assertIn("/sendMessage", url)
        self.assertIn(_TOKEN, url)
        self.assertEqual(payload["chat_id"], _CHAT)
        self.assertIn("#42", payload["text"])
        self.assertIn("green", payload["text"].lower())

    def test_escalation_notification_posts(self):
        transport = _FakeTransport()
        conn = TelegramConnector(token=_TOKEN, chat_id=_CHAT, transport=transport)
        conn.notify(escalation_event(issue_number=7, detail="budget exhausted"))
        text = transport.calls[0][1]["text"]
        self.assertIn("#7", text)
        self.assertIn("escalated", text.lower())

    def test_missing_token_or_chat_is_a_safe_no_op(self):
        transport = _FakeTransport()
        TelegramConnector(token=None, chat_id=_CHAT, transport=transport).notify(
            completion_event(issue_number=1)
        )
        TelegramConnector(token=_TOKEN, chat_id=None, transport=transport).notify(
            completion_event(issue_number=1)
        )
        self.assertEqual(transport.calls, [])

    def test_transport_error_is_swallowed(self):
        def boom(url, payload):
            raise OSError("network down")

        conn = TelegramConnector(token=_TOKEN, chat_id=_CHAT, transport=boom)
        conn.notify(completion_event(issue_number=1))  # must not raise

    def test_ingest_and_post_result_are_no_ops(self):
        conn = TelegramConnector(token=_TOKEN, chat_id=_CHAT)
        self.assertEqual(conn.ingest(), [])
        self.assertIsNone(
            conn.post_result(1, OutcomeReport(state="green", summary="x"))
        )

    def test_event_from_outcome_maps_state(self):
        esc = TelegramConnector.event_from_outcome(
            5, OutcomeReport(state="escalated-to-human", summary="nope")
        )
        self.assertEqual(esc.kind, "escalated")


class TelegramSeamTests(unittest.TestCase):
    def test_notify_task_done_posts(self):
        transport = _FakeTransport()
        notify_task_done(
            token=_TOKEN,
            chat_id=_CHAT,
            result=TaskResult(number=3, title="Fix bug", state="green", cost_usd=0.14),
            transport=transport,
        )
        url, payload = transport.calls[0]
        self.assertIn("/sendMessage", url)
        self.assertEqual(payload["chat_id"], _CHAT)
        self.assertIn("$0.14", payload["text"])

    def test_daily_digest_silent_on_empty_day(self):
        transport = _FakeTransport()
        notify_daily_digest(
            token=_TOKEN, chat_id=_CHAT, finished=[], transport=transport
        )
        self.assertEqual(transport.calls, [])

    def test_daily_digest_posts_summary(self):
        transport = _FakeTransport()
        notify_daily_digest(
            token=_TOKEN,
            chat_id=_CHAT,
            finished=[TaskResult(number=1, title="A", state="green")],
            transport=transport,
        )
        self.assertIn("digest", transport.calls[0][1]["text"].lower())


if __name__ == "__main__":
    unittest.main()

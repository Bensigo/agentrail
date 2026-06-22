"""Acceptance test: two-way Telegram inbound handling (issue #889).

This test is RED until the Implementer adds ``handle_inbound_update`` to
``agentrail.connectors.telegram``.  It drives the public function through a
fake transport so no live network is needed.

AC1  A message from a connected chat id receives a reply.
AC2  /status → run/queue snapshot (running / queued / escalated counts + issue
     numbers).
AC3  Unknown chat id → silence (no reply, no data leak).
AC4  Unrecognized input → short help reply listing what the bot can answer.
AC5  Malformed update → safe no-op (no crash, no exception).
"""
from __future__ import annotations

import unittest
from typing import Callable, Dict, List

# ``handle_inbound_update`` does not exist yet — this import is the expected
# red signal.  The Implementer must add this symbol to the telegram module.
from agentrail.connectors.telegram import handle_inbound_update  # type: ignore[attr-defined]

# ── fixtures ──────────────────────────────────────────────────────────────────

_TOKEN = "123456789:AAH" + "a" * 32
_CHAT_ID = "-1001234567890"
_OTHER_CHAT_ID = "-9999999999"


class _FakeTransport:
    """Captures every Bot API call instead of hitting the network."""

    def __init__(self, status: int = 200) -> None:
        self.status = status
        self.calls: List[tuple] = []

    def __call__(self, url: str, payload: dict) -> int:
        self.calls.append((url, payload))
        return self.status


def _msg(chat_id: str, text: str, update_id: int = 1) -> dict:
    """Minimal Telegram Bot API getUpdates message payload."""
    return {
        "update_id": update_id,
        "message": {
            "message_id": update_id,
            "from": {"id": 42, "is_bot": False, "first_name": "Alice"},
            "chat": {"id": int(chat_id), "type": "private"},
            "text": text,
        },
    }


def _snapshot() -> dict:
    """Fake workspace snapshot returned by the get_snapshot callable."""
    return {
        "running": 2,
        "queued": 3,
        "escalated": 1,
        "issues": [
            {"number": 12, "state": "running"},
            {"number": 34, "state": "queued"},
            {"number": 56, "state": "escalated"},
        ],
    }


# ── acceptance test ───────────────────────────────────────────────────────────

class TelegramInboundAcceptanceTest(unittest.TestCase):
    """One test class, five methods — one per AC for issue #889."""

    def test_ac1_connected_chat_receives_reply(self) -> None:
        """AC1: A message from the connected chat id produces exactly one reply."""
        transport = _FakeTransport()
        handle_inbound_update(
            _msg(_CHAT_ID, "/status"),
            token=_TOKEN,
            chat_id=_CHAT_ID,
            get_snapshot=_snapshot,
            transport=transport,
        )
        self.assertEqual(
            len(transport.calls),
            1,
            "Expected exactly one sendMessage call for a connected chat id",
        )
        url, payload = transport.calls[0]
        self.assertIn("/sendMessage", url)
        self.assertIn(_TOKEN, url)
        # Reply is addressed back to the same chat.
        self.assertEqual(str(payload["chat_id"]), _CHAT_ID)

    def test_ac2_status_returns_run_queue_snapshot(self) -> None:
        """AC2: /status reply includes running/queued/escalated counts and issue numbers."""
        transport = _FakeTransport()
        handle_inbound_update(
            _msg(_CHAT_ID, "/status"),
            token=_TOKEN,
            chat_id=_CHAT_ID,
            get_snapshot=_snapshot,
            transport=transport,
        )
        self.assertEqual(len(transport.calls), 1)
        text = transport.calls[0][1]["text"]
        # Snapshot counts (running=2, queued=3, escalated=1) must appear.
        self.assertIn("2", text, "running count must appear in status reply")
        self.assertIn("3", text, "queued count must appear in status reply")
        self.assertIn("1", text, "escalated count must appear in status reply")
        # At least the running issue number must be surfaced.
        self.assertIn("12", text, "running issue #12 must appear in status reply")

    def test_ac3_unknown_chat_id_is_ignored(self) -> None:
        """AC3: A message from a chat id not linked to any workspace gets no reply."""
        transport = _FakeTransport()
        handle_inbound_update(
            _msg(_OTHER_CHAT_ID, "/status"),
            token=_TOKEN,
            chat_id=_CHAT_ID,          # workspace is linked to _CHAT_ID only
            get_snapshot=_snapshot,
            transport=transport,
        )
        self.assertEqual(
            transport.calls,
            [],
            "Unknown chat id must produce no reply and no data leak",
        )

    def test_ac4_unrecognized_input_returns_help(self) -> None:
        """AC4: Unknown text → short help message listing what the bot can answer."""
        transport = _FakeTransport()
        handle_inbound_update(
            _msg(_CHAT_ID, "what is the meaning of life?"),
            token=_TOKEN,
            chat_id=_CHAT_ID,
            get_snapshot=_snapshot,
            transport=transport,
        )
        self.assertEqual(
            len(transport.calls),
            1,
            "Unrecognized input must receive a help reply",
        )
        text = transport.calls[0][1]["text"].lower()
        # Help must tell the user what the bot understands.
        self.assertIn("status", text, "Help reply must mention /status")

    def test_ac5_malformed_update_does_not_crash(self) -> None:
        """AC5: Any malformed update is a safe no-op — no exception escapes."""
        transport = _FakeTransport()
        bad_updates = [
            {},
            {"update_id": 1},                                           # no message key
            {"message": None},                                          # None message
            {"message": {"chat": {}}},                                  # no text field
            {"message": {"chat": {"id": "not-an-int"}, "text": "/status"}},
            "not a dict at all",                                        # wrong type
            None,                                                       # None
            [],                                                         # list
        ]
        for bad in bad_updates:
            with self.subTest(update=bad):
                try:
                    handle_inbound_update(
                        bad,  # type: ignore[arg-type]
                        token=_TOKEN,
                        chat_id=_CHAT_ID,
                        get_snapshot=_snapshot,
                        transport=transport,
                    )
                except Exception as exc:  # noqa: BLE001
                    self.fail(
                        f"handle_inbound_update raised on malformed update "
                        f"{bad!r}: {exc!r}"
                    )


if __name__ == "__main__":
    unittest.main()

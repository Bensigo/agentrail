"""Acceptance test for issue #888 — gateway notifications on runner-executed
terminal outcomes.

RED STATE: ``agentrail.connectors.gateway`` does not exist yet, so this module
fails on import with ``ImportError``.  The Implementer must create
``notify_run_outcome`` in that module and wire it into the runner result path
before this test can go green.

Acceptance criteria covered
----------------------------
AC1  Green terminal fires notify with issue number, "green" outcome, and PR link.
AC2  All three terminals (green / escalated-to-human / blocked) trigger notify.
AC3  A notify exception is swallowed — best-effort, never alters the result.
AC4  A non-terminal ``running`` heartbeat fires nothing.
AC5  The function is connector-agnostic: any Connector whose ``notify`` is
     callable goes through the same dispatch path.

Public interface under test
----------------------------
``notify_run_outcome(connectors, *, issue_number, outcome, pr_url="") -> None``

  connectors  — sequence of gateway :class:`~agentrail.connectors.base.Connector`
                objects that are already loaded for the workspace.
  issue_number — the issue ref (int).
  outcome      — the Run-Outcome terminal state in CONTEXT.md vocabulary:
                 ``"green"`` / ``"escalated-to-human"`` / ``"blocked"``.
                 A non-terminal value (e.g. ``"running"``) must be a no-op.
  pr_url       — optional PR / branch URL; included in the notification when
                 present (AC1).
"""
from __future__ import annotations

import unittest

from agentrail.connectors.base import ConnectorEvent, IngestedIssue, OutcomeReport

# ── The module under test ─────────────────────────────────────────────────────
# This import FAILS (ImportError) until the Implementer creates
# agentrail/connectors/gateway.py with notify_run_outcome.
from agentrail.connectors.gateway import notify_run_outcome  # noqa: E402


# ── Test doubles ─────────────────────────────────────────────────────────────

class _FakeGateway:
    """A minimal gateway connector that records every notify() call."""

    def __init__(self) -> None:
        self.notified: list[ConnectorEvent] = []

    # -- Connector surface -------------------------------------------------- #
    def ingest(self) -> list[IngestedIssue]:
        return []

    def post_result(self, issue_ref: int, outcome: OutcomeReport) -> None:
        return None

    def notify(self, event: ConnectorEvent) -> None:
        self.notified.append(event)


class _ExplodingGateway(_FakeGateway):
    """A gateway connector whose notify always raises (simulates unreachable chat)."""

    def notify(self, event: ConnectorEvent) -> None:
        raise OSError("telegram: connection refused")


# ── AC1 + AC2: terminal outcomes fire notify ──────────────────────────────────

class TestTerminalOutcomesFireNotify(unittest.TestCase):

    def test_green_outcome_calls_notify_with_issue_number(self):
        """AC1/AC2 — a green terminal posts to the connector."""
        gw = _FakeGateway()
        notify_run_outcome([gw], issue_number=42, outcome="green")
        self.assertEqual(len(gw.notified), 1)
        self.assertEqual(gw.notified[0].issue_number, 42)

    def test_green_outcome_includes_pr_url_in_event(self):
        """AC1 — the PR link is surfaced when provided."""
        gw = _FakeGateway()
        notify_run_outcome(
            [gw], issue_number=42, outcome="green", pr_url="https://github.com/o/r/pull/99"
        )
        ev = gw.notified[0]
        # The PR URL must appear somewhere in the event so connectors can render it.
        self.assertIn("https://github.com/o/r/pull/99", ev.detail)

    def test_escalated_to_human_outcome_calls_notify(self):
        """AC2 — escalated-to-human terminal is notified."""
        gw = _FakeGateway()
        notify_run_outcome([gw], issue_number=7, outcome="escalated-to-human")
        self.assertEqual(len(gw.notified), 1)
        self.assertEqual(gw.notified[0].issue_number, 7)

    def test_blocked_outcome_calls_notify(self):
        """AC2 — blocked terminal is notified (not only green/escalated)."""
        gw = _FakeGateway()
        notify_run_outcome([gw], issue_number=5, outcome="blocked")
        self.assertEqual(len(gw.notified), 1)
        self.assertEqual(gw.notified[0].issue_number, 5)

    def test_notify_called_for_all_three_terminals(self):
        """AC2 — a single pass over green / escalated-to-human / blocked all fire."""
        for outcome in ("green", "escalated-to-human", "blocked"):
            with self.subTest(outcome=outcome):
                gw = _FakeGateway()
                notify_run_outcome([gw], issue_number=1, outcome=outcome)
                self.assertEqual(
                    len(gw.notified), 1,
                    f"Expected 1 notify call for outcome '{outcome}', got {len(gw.notified)}",
                )


# ── AC3: notify failure is swallowed ─────────────────────────────────────────

class TestNotifyFailureIsSwallowed(unittest.TestCase):

    def test_transport_error_does_not_raise(self):
        """AC3 — an exception inside notify must not propagate to the caller."""
        boom = _ExplodingGateway()
        # Must complete without raising; a notification blip is never a gate.
        notify_run_outcome([boom], issue_number=1, outcome="green")

    def test_transport_error_does_not_prevent_other_connectors_from_being_notified(self):
        """AC3/AC5 — if one connector explodes, the remaining ones still receive
        the notification (best-effort, not an all-or-nothing batch)."""
        boom = _ExplodingGateway()
        ok = _FakeGateway()
        notify_run_outcome([boom, ok], issue_number=3, outcome="green")
        self.assertEqual(len(ok.notified), 1)


# ── AC4: non-terminal 'running' heartbeat fires nothing ──────────────────────

class TestRunningHeartbeatIsNotNotified(unittest.TestCase):

    def test_running_status_sends_nothing(self):
        """AC4 — a heartbeat (running) update must never trigger a gateway notify."""
        gw = _FakeGateway()
        notify_run_outcome([gw], issue_number=1, outcome="running")
        self.assertEqual(
            gw.notified, [],
            "notify_run_outcome must be a no-op for the non-terminal 'running' outcome",
        )

    def test_empty_connector_list_is_a_no_op(self):
        """Edge case: no connected gateways → completes silently."""
        notify_run_outcome([], issue_number=1, outcome="green")  # must not raise


# ── AC5: connector-agnostic dispatch ─────────────────────────────────────────

class TestConnectorAgnosticDispatch(unittest.TestCase):

    def test_multiple_connectors_all_receive_the_same_outcome(self):
        """AC5 — Slack, Telegram, Discord (or any Connector) go through one path."""
        telegram = _FakeGateway()
        slack = _FakeGateway()
        discord = _FakeGateway()
        notify_run_outcome(
            [telegram, slack, discord], issue_number=10, outcome="green"
        )
        for conn, name in [(telegram, "telegram"), (slack, "slack"), (discord, "discord")]:
            self.assertEqual(
                len(conn.notified), 1,
                f"Expected 1 notify call on {name} connector",
            )
            self.assertEqual(conn.notified[0].issue_number, 10)


if __name__ == "__main__":
    unittest.main()

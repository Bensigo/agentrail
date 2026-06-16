"""The shared Connector interface (M038, AC1).

A connector is the two-way seam between an external tool (GitHub, Linear,
Discord) and the **Issue Queue** (CONTEXT.md): it *ingests* human-created issues
into the queue and *reports results* back. The interface is deliberately tiny —
``ingest`` / ``post_result`` / ``notify`` — so each adapter is a deep module
behind a small surface (verification-contract-architecture.md).
"""
from __future__ import annotations

import unittest

from agentrail.connectors.base import (
    ConnectorEvent,
    IngestedIssue,
    OutcomeReport,
    Connector,
)


class InterfaceShapeTests(unittest.TestCase):
    def test_connector_is_abstract_with_the_three_methods(self):
        # The interface exists and declares exactly the three two-way methods.
        for name in ("ingest", "post_result", "notify"):
            self.assertTrue(
                hasattr(Connector, name),
                f"Connector interface is missing {name}",
            )
        # It is an ABC: it cannot be instantiated without implementing them.
        with self.assertRaises(TypeError):
            Connector()  # type: ignore[abstract]

    def test_partial_implementation_is_still_abstract(self):
        class Half(Connector):
            def ingest(self):  # pragma: no cover - never instantiated
                return []

        with self.assertRaises(TypeError):
            Half()  # type: ignore[abstract]

    def test_full_implementation_instantiates(self):
        class Full(Connector):
            def ingest(self):
                return []

            def post_result(self, issue_ref, outcome):
                return None

            def notify(self, event):
                return None

        c = Full()
        self.assertEqual(c.ingest(), [])


class ValueTypeTests(unittest.TestCase):
    def test_ingested_issue_carries_number_and_admission(self):
        issue = IngestedIssue(number=12, title="t", admitted=True, reason=None)
        self.assertEqual(issue.number, 12)
        self.assertTrue(issue.admitted)

    def test_outcome_report_renders_a_human_body(self):
        report = OutcomeReport(state="green", summary="all checks pass")
        body = report.to_comment()
        self.assertIn("green", body.lower())
        self.assertIn("all checks pass", body)

    def test_connector_event_is_frozen_value(self):
        ev = ConnectorEvent(kind="completed", issue_number=7, detail="done")
        self.assertEqual(ev.kind, "completed")
        with self.assertRaises(Exception):
            ev.kind = "x"  # type: ignore[misc]


if __name__ == "__main__":
    unittest.main()

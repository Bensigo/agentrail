"""Linear adapter integration tests against a MOCKED Linear API (M038, AC1/AC2).

The key test the issue asks for: ingest a Linear issue → it lands in the queue
*through the input-contract gate* (agentrail/afk/input_contract.admit_to_queue);
post_result posts the run result back to the issue. Every HTTP call is mocked via
an injected transport — no live network (mirrors the GitHub adapter's mocked-API
test, which patches the single ``_run`` seam).

Linear's API is GraphQL: ingest runs an ``issues`` query filtered by a label;
post_result runs a ``commentCreate`` mutation on the issue. The adapter takes an
injectable ``transport`` callable so the test replays canned GraphQL responses.
"""
from __future__ import annotations

import json
import unittest

from agentrail.connectors.linear import LinearConnector
from agentrail.connectors.base import ConnectorEvent, IngestedIssue, OutcomeReport
from agentrail.afk.queue_state import QueueEntry, QueueState


# An issue body WITH machine-checkable (checkbox) acceptance criteria → admitted.
_GOOD_BODY = (
    "## What to build\nA thing.\n\n"
    "## Acceptance criteria\n- [ ] AC1: it works\n- [ ] AC2: it is tested\n"
)
# An issue body with NO checkbox AC → rejected by the input-contract gate.
_BAD_BODY = "## What to build\nvibes only, no acceptance criteria section\n"


def _issue_node(identifier, number, title, body, url="https://linear.app/x"):
    """Shape one Linear ``Issue`` node as the GraphQL ``issues`` query returns it."""
    return {
        "id": identifier,
        "number": number,
        "title": title,
        "description": body,
        "url": url,
    }


def _fake_transport(responses):
    """Build a fake transport that replays canned GraphQL payloads by op key.

    ``responses`` maps a substring of the GraphQL query/mutation string to the
    parsed JSON payload it should return. The first matching key wins. Records
    every call so the test can assert what was sent.
    """
    calls = []

    def _transport(query: str, variables: dict) -> dict:
        calls.append({"query": query, "variables": variables})
        for needle, payload in responses.items():
            if needle in query:
                return payload
        return {"data": {}}

    _transport.calls = calls
    return _transport


class IngestThroughGateTests(unittest.TestCase):
    def test_labeled_issue_with_ac_lands_in_queue(self):
        payload = {
            "data": {
                "issues": {
                    "nodes": [
                        _issue_node("lin_1", 42, "Add widget", _GOOD_BODY, "u")
                    ]
                }
            }
        }
        transport = _fake_transport({"issues": payload})
        conn = LinearConnector(
            api_key="lin_api_test", ingest_label="ready-for-agent", transport=transport
        )
        ingested = conn.ingest()

        self.assertEqual(len(ingested), 1)
        self.assertIsInstance(ingested[0], IngestedIssue)
        self.assertEqual(ingested[0].number, 42)
        # Admitted through the gate → a real QueueEntry was minted.
        self.assertTrue(ingested[0].admitted)
        self.assertIsInstance(ingested[0].entry, QueueEntry)
        self.assertEqual(ingested[0].entry.number, 42)
        self.assertEqual(ingested[0].entry.state, QueueState.QUEUED)

    def test_labeled_issue_without_ac_is_rejected_at_the_gate(self):
        payload = {
            "data": {
                "issues": {
                    "nodes": [_issue_node("lin_7", 7, "Vibes", _BAD_BODY, "u")]
                }
            }
        }
        transport = _fake_transport({"issues": payload})
        conn = LinearConnector(api_key="k", ingest_label="ready-for-agent", transport=transport)
        ingested = conn.ingest()

        self.assertEqual(len(ingested), 1)
        self.assertFalse(ingested[0].admitted)
        self.assertIsNone(ingested[0].entry)
        self.assertIn("acceptance", ingested[0].reason.lower())

    def test_empty_label_list_yields_no_ingested_issues(self):
        transport = _fake_transport({"issues": {"data": {"issues": {"nodes": []}}}})
        conn = LinearConnector(api_key="k", transport=transport)
        self.assertEqual(conn.ingest(), [])

    def test_ingest_filters_by_the_configured_label(self):
        transport = _fake_transport(
            {"issues": {"data": {"issues": {"nodes": []}}}}
        )
        conn = LinearConnector(api_key="k", ingest_label="afk-ready", transport=transport)
        conn.ingest()
        self.assertEqual(len(transport.calls), 1)
        variables = transport.calls[0]["variables"]
        # The label name is carried in the GraphQL variables, not interpolated.
        self.assertIn("afk-ready", json.dumps(variables))


class PostResultTests(unittest.TestCase):
    def test_post_result_comments_the_outcome_back_on_the_issue(self):
        transport = _fake_transport(
            {"commentCreate": {"data": {"commentCreate": {"success": True}}}}
        )
        conn = LinearConnector(api_key="k", transport=transport)
        conn.post_result("lin_1", OutcomeReport(state="green", summary="gate passed"))

        mutations = [c for c in transport.calls if "commentCreate" in c["query"]]
        self.assertEqual(len(mutations), 1)
        variables = mutations[0]["variables"]
        self.assertEqual(variables["issueId"], "lin_1")
        body = variables["body"]
        self.assertIn("gate passed", body)
        self.assertIn("green", body.lower())


class NotifyTests(unittest.TestCase):
    def test_notify_is_a_safe_noop_returning_none(self):
        # Linear's back channel is the issue comment (post_result); notify is a
        # no-op (Discord owns channel notifications) and must not raise or call out.
        transport = _fake_transport({})
        conn = LinearConnector(api_key="k", transport=transport)
        self.assertIsNone(
            conn.notify(ConnectorEvent(kind="completed", issue_number=42))
        )
        self.assertEqual(transport.calls, [])


if __name__ == "__main__":
    unittest.main()

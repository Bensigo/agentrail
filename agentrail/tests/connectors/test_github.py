"""GitHub adapter integration tests against a MOCKED GitHub API (M038, AC2).

The key test the issue asks for: ingest a labeled issue → it lands in the queue
*through the input-contract gate* (agentrail/afk/input_contract.admit_to_queue);
post_result posts the run result back to the issue. Every ``gh`` call is mocked
— no live network.

The adapter reuses the consolidated GitHub CLI primitives (formerly
``agentrail/afk/github.py``, now ``agentrail/connectors/github.py``); we patch
the single ``_run`` seam so listing/fetching/commenting all go through the mock.
"""
from __future__ import annotations

import json
import unittest
from unittest import mock

from agentrail.connectors import github as ghmod
from agentrail.connectors.github import GitHubConnector
from agentrail.connectors.base import IngestedIssue, OutcomeReport
from agentrail.afk.queue_state import QueueEntry, QueueState


# An issue body WITH machine-checkable (checkbox) acceptance criteria → admitted.
_GOOD_BODY = (
    "## What to build\nA thing.\n\n"
    "## Acceptance criteria\n- [ ] AC1: it works\n- [ ] AC2: it is tested\n"
)
# An issue body with NO checkbox AC → rejected by the input-contract gate.
_BAD_BODY = "## What to build\nvibes only, no acceptance criteria section\n"


def _fake_gh(responses):
    """Build a fake ``_run`` that replays canned (rc, stdout, stderr) by argv key.

    ``responses`` maps a substring of the joined argv to its result; the first
    matching key wins. Unmatched calls return a benign success so commenting /
    labeling never explode the test.
    """
    calls = []

    def _run(args, check=False):
        calls.append(list(args))
        joined = " ".join(args)
        for needle, result in responses.items():
            if needle in joined:
                return result
        return (0, "", "")

    _run.calls = calls
    return _run


class IngestThroughGateTests(unittest.TestCase):
    def test_labeled_issue_with_ac_lands_in_queue(self):
        # gh issue list returns one labeled issue; gh issue view returns its body.
        list_json = json.dumps(
            [{"number": 42, "title": "Add widget", "url": "u", "body": _GOOD_BODY}]
        )
        fake = _fake_gh(
            {
                "issue list": (0, list_json, ""),
                "issue view": (0, json.dumps({"body": _GOOD_BODY}), ""),
            }
        )
        with mock.patch.object(ghmod, "_run", fake):
            conn = GitHubConnector(afk_label="afk", queue_labels=["ready-for-agent"])
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
        list_json = json.dumps(
            [{"number": 7, "title": "Vibes", "url": "u", "body": _BAD_BODY}]
        )
        fake = _fake_gh(
            {
                "issue list": (0, list_json, ""),
                "issue view": (0, json.dumps({"body": _BAD_BODY}), ""),
            }
        )
        with mock.patch.object(ghmod, "_run", fake):
            conn = GitHubConnector(afk_label="afk", queue_labels=["ready-for-agent"])
            ingested = conn.ingest()

        self.assertEqual(len(ingested), 1)
        self.assertFalse(ingested[0].admitted)
        self.assertIsNone(ingested[0].entry)
        self.assertIn("acceptance", ingested[0].reason.lower())

    def test_empty_label_list_yields_no_ingested_issues(self):
        fake = _fake_gh({"issue list": (0, "[]", "")})
        with mock.patch.object(ghmod, "_run", fake):
            conn = GitHubConnector(afk_label="afk", queue_labels=["ready-for-agent"])
            self.assertEqual(conn.ingest(), [])


class PostResultTests(unittest.TestCase):
    def test_post_result_comments_the_outcome_back_on_the_issue(self):
        fake = _fake_gh({})
        with mock.patch.object(ghmod, "_run", fake):
            conn = GitHubConnector(afk_label="afk", queue_labels=["ready-for-agent"])
            conn.post_result(42, OutcomeReport(state="green", summary="gate passed"))

        # Exactly one gh issue comment call, on #42, carrying the outcome.
        comment_calls = [c for c in fake.calls if c[:2] == ["issue", "comment"]]
        self.assertEqual(len(comment_calls), 1)
        argv = comment_calls[0]
        self.assertIn("42", argv)
        body = argv[argv.index("--body") + 1]
        self.assertIn("gate passed", body)
        self.assertIn("green", body.lower())


class NotifyTests(unittest.TestCase):
    def test_notify_is_a_safe_noop_returning_none(self):
        # GitHub's notification surface is the issue comment itself; notify is a
        # no-op here (Discord owns channel notifications) and must not raise.
        fake = _fake_gh({})
        with mock.patch.object(ghmod, "_run", fake):
            conn = GitHubConnector(afk_label="afk", queue_labels=["ready-for-agent"])
            from agentrail.connectors.base import ConnectorEvent

            self.assertIsNone(
                conn.notify(ConnectorEvent(kind="completed", issue_number=42))
            )


class ConsolidationTests(unittest.TestCase):
    """The old import path keeps working (no second GitHub client)."""

    def test_afk_github_reexports_the_primitives(self):
        from agentrail.afk import github as afk_github

        # Same function objects, re-exported from the consolidated module.
        self.assertIs(afk_github.parse_blocked_by, ghmod.parse_blocked_by)
        self.assertIs(afk_github.list_queue_issues, ghmod.list_queue_issues)
        self.assertIs(afk_github.merge_pr_squash, ghmod.merge_pr_squash)


if __name__ == "__main__":
    unittest.main()

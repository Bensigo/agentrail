"""Tests for the dependency-aware AFK queue.

Two pure layers:
  * ``github.parse_blocked_by`` — extract blocker #numbers from an issue body's
    ``## Blocked by`` section.
  * ``AfkState.next_claimable`` / ``Store.claim_next`` — withhold an issue while
    any of its blockers is still open.
"""
from __future__ import annotations

import unittest

from agentrail.afk import github
from agentrail.afk.state import (
    AfkState,
    EnqueueIssue,
    IssueStatus,
    SetBlockedBy,
    Store,
    reduce,
)


class ParseBlockedByTests(unittest.TestCase):
    def test_none_section_is_unblocked(self):
        body = "## What to build\n\nstuff\n\n## Blocked by\n\nNone — can start immediately.\n"
        self.assertEqual(github.parse_blocked_by(body), [])

    def test_single_blocker(self):
        body = "## Blocked by\n\n- #543 (the schema slice)\n"
        self.assertEqual(github.parse_blocked_by(body), [543])

    def test_multiple_blockers_dedup_order(self):
        body = "## Blocked by\n\n- #10\n- #4\n- #10 again\n\n## Notes\n#999 not a blocker\n"
        self.assertEqual(github.parse_blocked_by(body), [10, 4])

    def test_no_section(self):
        self.assertEqual(github.parse_blocked_by("just a body, no section"), [])

    def test_empty_or_none_body(self):
        self.assertEqual(github.parse_blocked_by(""), [])
        self.assertEqual(github.parse_blocked_by(None), [])

    def test_hashes_outside_section_ignored(self):
        body = "Fixes #1 and #2 in the prose.\n\n## Blocked by\n\n#7\n"
        self.assertEqual(github.parse_blocked_by(body), [7])


def _state(*issues) -> AfkState:
    s = AfkState(concurrency=1, slots={0: None})
    for num, blocked in issues:
        s = reduce(s, EnqueueIssue(num, f"#{num}", "", blocked_by=tuple(blocked)))
    return s


class NextClaimableTests(unittest.TestCase):
    def test_no_blockers_equals_next_queued(self):
        s = _state((5, ()), (3, ()), (9, ()))
        self.assertEqual(s.next_claimable(frozenset()).number, 3)
        self.assertEqual(s.next_claimable().number, s.next_queued().number)

    def test_blocked_issue_skipped_when_blocker_open(self):
        s = _state((1, ()), (2, (1,)))
        # #1 open → #2 withheld, #1 chosen
        self.assertEqual(s.next_claimable(frozenset({1})).number, 1)

    def test_blocked_issue_unblocked_when_blocker_closed(self):
        from agentrail.afk.state import SetStatus
        s = _state((1, ()), (2, (1,)))
        s = reduce(s, SetStatus(1, IssueStatus.MERGED))  # #1 done, only #2 queued
        # #1 merged → not reported open → #2 claimable
        self.assertEqual(s.next_claimable(frozenset()).number, 2)
        # but if #1 were still reported open, #2 stays withheld
        self.assertIsNone(s.next_claimable(frozenset({1})))

    def test_all_blocked_returns_none(self):
        s = _state((2, (99,)), (3, (99,)))
        self.assertIsNone(s.next_claimable(frozenset({99})))
        self.assertTrue(s.has_blocked_pending(frozenset({99})))

    def test_lowest_claimable_chosen_over_blocked_lower(self):
        # #1 blocked by open #50, #2 free → #2 wins despite higher number
        s = _state((1, (50,)), (2, ()))
        self.assertEqual(s.next_claimable(frozenset({50})).number, 2)


class ClaimNextTests(unittest.TestCase):
    def test_claim_respects_blockers(self):
        store = Store(_state((1, (50,)), (2, ())))
        claimed = store.claim_next(frozenset({50}))
        self.assertEqual(claimed.number, 2)  # #1 withheld by open #50

    def test_claim_none_when_only_blocked(self):
        store = Store(_state((1, (50,))))
        self.assertIsNone(store.claim_next(frozenset({50})))
        # blocker resolved → claimable
        self.assertEqual(store.claim_next(frozenset()).number, 1)


class SetBlockedByTests(unittest.TestCase):
    def test_refresh_existing_blockers(self):
        s = _state((2, ()))
        s = reduce(s, SetBlockedBy(2, (1,)))
        self.assertEqual(s.issues[2].blocked_by, (1,))
        # idempotent / unknown issue safe
        before = s
        s = reduce(s, SetBlockedBy(2, (1,)))
        self.assertIs(s, before)
        s = reduce(s, SetBlockedBy(999, (1,)))
        self.assertIs(s, before)


if __name__ == "__main__":
    unittest.main()

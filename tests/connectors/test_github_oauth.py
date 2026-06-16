"""GitHub OAuth connector tests against a MOCKED GitHub REST API (MVP).

The MVP path the issue asks for: a labeled GitHub issue flows into the queue via
the user's stored OAuth token (no PAT, no ``gh`` CLI), and run results post back
to the issue. Every HTTP call is mocked via an injected transport — no live
network (mirrors the Linear adapter's injectable-transport test).

Three behaviours are exercised:

- ``poll(workspace_id)`` lists OPEN issues carrying the trigger label
  ``ready-for-agent`` across the workspace's linked repos, as ``IssueRef``.
- ``post_result(issue_ref, result)`` posts a comment with the run outcome.
- ``create_issue(...)`` opens a GitHub issue WITH the trigger label (so the
  connector/heartbeat then picks it up).

The OAuth client talks GitHub REST over an injectable ``transport`` callable so
the tests replay canned JSON responses against a mocked API.
"""
from __future__ import annotations

import json
import unittest

from agentrail.connectors.base import IssueRef, OutcomeReport
from agentrail.connectors.github import GitHubOAuthClient


def _fake_transport(routes):
    """Build a fake REST transport that replays canned responses by (method, path).

    ``routes`` maps ``"<METHOD> <path-substring>"`` to either a parsed-JSON value
    or a ``(status, json)`` tuple. The first matching key wins. Records every call
    (method, url, headers, body) so tests can assert what was sent.
    """
    calls = []

    def _transport(method, url, headers=None, body=None):
        calls.append(
            {"method": method, "url": url, "headers": headers or {}, "body": body}
        )
        for needle, result in routes.items():
            nm, _, npath = needle.partition(" ")
            if method == nm and npath in url:
                if isinstance(result, tuple):
                    return result
                return (200, result)
        return (200, [])

    _transport.calls = calls
    return _transport


# An issue body WITH machine-checkable (checkbox) acceptance criteria.
_GOOD_BODY = (
    "## What to build\nA thing.\n\n"
    "## Acceptance criteria\n- [ ] AC1: it works\n- [ ] AC2: it is tested\n"
)


def _gh_issue(number, title, body, *, is_pr=False):
    """Shape one GitHub REST issue object as the search/list endpoints return it."""
    obj = {
        "number": number,
        "title": title,
        "body": body,
        "html_url": f"https://github.com/acme/widgets/issues/{number}",
    }
    if is_pr:
        obj["pull_request"] = {"url": "https://api.github.com/.../pulls/1"}
    return obj


class PollTests(unittest.TestCase):
    def test_poll_lists_labeled_open_issues_as_issue_refs(self):
        listing = [
            _gh_issue(42, "Add widget", _GOOD_BODY),
            _gh_issue(43, "Add gadget", _GOOD_BODY),
        ]
        transport = _fake_transport(
            {"GET /repos/acme/widgets/issues": (200, listing)}
        )
        client = GitHubOAuthClient(
            token="gho_test",
            repos=["acme/widgets"],
            transport=transport,
        )
        refs = client.poll(workspace_id="ws-1")

        self.assertEqual(len(refs), 2)
        self.assertIsInstance(refs[0], IssueRef)
        self.assertEqual(refs[0].repo, "acme/widgets")
        self.assertEqual(refs[0].number, 42)
        self.assertEqual(refs[0].title, "Add widget")
        self.assertEqual(refs[0].body, _GOOD_BODY)
        self.assertEqual(
            refs[0].url, "https://github.com/acme/widgets/issues/42"
        )

    def test_poll_requests_open_state_and_the_trigger_label(self):
        transport = _fake_transport({"GET /repos/acme/widgets/issues": (200, [])})
        client = GitHubOAuthClient(
            token="gho_test", repos=["acme/widgets"], transport=transport
        )
        client.poll(workspace_id="ws-1")

        self.assertEqual(len(transport.calls), 1)
        url = transport.calls[0]["url"]
        self.assertIn("state=open", url)
        self.assertIn("labels=ready-for-agent", url)

    def test_poll_uses_the_oauth_bearer_token(self):
        transport = _fake_transport({"GET /repos/acme/widgets/issues": (200, [])})
        client = GitHubOAuthClient(
            token="gho_secret", repos=["acme/widgets"], transport=transport
        )
        client.poll(workspace_id="ws-1")
        headers = transport.calls[0]["headers"]
        # Bearer token, never a PAT or gh CLI.
        self.assertEqual(headers.get("Authorization"), "Bearer gho_secret")

    def test_poll_skips_pull_requests(self):
        # GitHub's issues endpoint returns PRs too; they carry a pull_request key.
        listing = [
            _gh_issue(42, "Real issue", _GOOD_BODY),
            _gh_issue(99, "A PR", _GOOD_BODY, is_pr=True),
        ]
        transport = _fake_transport(
            {"GET /repos/acme/widgets/issues": (200, listing)}
        )
        client = GitHubOAuthClient(
            token="t", repos=["acme/widgets"], transport=transport
        )
        refs = client.poll(workspace_id="ws-1")
        self.assertEqual([r.number for r in refs], [42])

    def test_poll_spans_multiple_linked_repos(self):
        transport = _fake_transport(
            {
                "GET /repos/acme/widgets/issues": (200, [_gh_issue(1, "A", _GOOD_BODY)]),
                "GET /repos/acme/gadgets/issues": (200, [_gh_issue(2, "B", _GOOD_BODY)]),
            }
        )
        client = GitHubOAuthClient(
            token="t",
            repos=["acme/widgets", "acme/gadgets"],
            transport=transport,
        )
        refs = client.poll(workspace_id="ws-1")
        self.assertEqual({(r.repo, r.number) for r in refs}, {("acme/widgets", 1), ("acme/gadgets", 2)})

    def test_poll_with_no_linked_repos_returns_empty(self):
        transport = _fake_transport({})
        client = GitHubOAuthClient(token="t", repos=[], transport=transport)
        self.assertEqual(client.poll(workspace_id="ws-1"), [])
        self.assertEqual(transport.calls, [])


class PostResultTests(unittest.TestCase):
    def test_post_result_posts_a_comment_with_the_outcome(self):
        transport = _fake_transport(
            {"POST /repos/acme/widgets/issues/42/comments": (201, {"id": 1})}
        )
        client = GitHubOAuthClient(token="t", repos=["acme/widgets"], transport=transport)
        ref = IssueRef(repo="acme/widgets", number=42, title="t", body="b", url="u")
        client.post_result(ref, OutcomeReport(state="green", summary="gate passed"))

        posts = [
            c for c in transport.calls
            if c["method"] == "POST" and "/issues/42/comments" in c["url"]
        ]
        self.assertEqual(len(posts), 1)
        sent = json.loads(posts[0]["body"])
        self.assertIn("gate passed", sent["body"])
        self.assertIn("green", sent["body"].lower())
        self.assertEqual(posts[0]["headers"].get("Authorization"), "Bearer t")


class CreateIssueTests(unittest.TestCase):
    def test_create_issue_opens_a_labeled_issue(self):
        created = {
            "number": 7,
            "title": "New task",
            "html_url": "https://github.com/acme/widgets/issues/7",
        }
        transport = _fake_transport(
            {"POST /repos/acme/widgets/issues": (201, created)}
        )
        client = GitHubOAuthClient(token="t", repos=["acme/widgets"], transport=transport)
        ref = client.create_issue(
            repo="acme/widgets", title="New task", body=_GOOD_BODY
        )

        posts = [
            c for c in transport.calls
            if c["method"] == "POST" and c["url"].endswith("/repos/acme/widgets/issues")
        ]
        self.assertEqual(len(posts), 1)
        sent = json.loads(posts[0]["body"])
        self.assertEqual(sent["title"], "New task")
        self.assertEqual(sent["body"], _GOOD_BODY)
        # Carries the trigger label so the connector/heartbeat picks it up.
        self.assertIn("ready-for-agent", sent["labels"])
        self.assertEqual(posts[0]["headers"].get("Authorization"), "Bearer t")

        self.assertIsInstance(ref, IssueRef)
        self.assertEqual(ref.repo, "acme/widgets")
        self.assertEqual(ref.number, 7)
        self.assertEqual(ref.url, "https://github.com/acme/widgets/issues/7")


if __name__ == "__main__":
    unittest.main()

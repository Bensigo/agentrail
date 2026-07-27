"""Tests for `agentrail context wiki status|show|search`'s server-first wiring
(context source registry spec §K step 2 —
docs/superpowers/specs/2026-07-27-context-source-registry-design.md).

These call ``_run_wiki`` directly with the read client patched, rather than
shelling out like test_context_cli.py does: the behaviour under test is which
SOURCE the command reads from and how it degrades, which needs a controllable
server, and a subprocess cannot be handed one.

The guarantee that matters across all of them: a clone that is not linked, or
a server that is down, must behave exactly as it did before this wiring
existed — read local files, print the same thing. The server is an upgrade,
never a new dependency.
"""
from __future__ import annotations

import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from agentrail.cli.commands.context import _run_wiki


def _target() -> str:
    return str(Path(tempfile.mkdtemp()))


def _run(*args) -> str:
    out = io.StringIO()
    with redirect_stdout(out):
        code = _run_wiki(list(args))
    assert code == 0, f"expected exit 0, got {code}"
    return out.getvalue()


_SERVER_STATUS = {
    "compiled": True,
    "compiledAt": "2026-07-24T00:00:00Z",
    "commitSha": "abc123",
    "origin": "server",
    "pages": [
        {
            "slug": "wiki/overview",
            "file": None,
            "inputsHash": "sha256:deadbeef",
            "currentInputsHash": None,
            "stale": False,
            "generatedAt": "2026-07-24T00:00:00Z",
            "ageSeconds": None,
            "model": "claude-haiku-4.5",
        }
    ],
}


class StatusTests(unittest.TestCase):
    def test_prefers_the_server_and_says_so(self) -> None:
        with mock.patch("agentrail.cli.commands.context.wiki_client.remote_status", return_value=_SERVER_STATUS):
            output = _run("status", "--target", _target())
        self.assertIn("origin=server", output)
        self.assertIn("wiki/overview", output)

    def test_falls_back_to_local_files_when_the_server_is_unavailable(self) -> None:
        """None from the client means "could not answer" — the local reader
        still runs, and an unhydrated clone gets the same guidance it always
        did."""
        with mock.patch("agentrail.cli.commands.context.wiki_client.remote_status", return_value=None):
            output = _run("status", "--target", _target())
        self.assertIn("No wiki pages available", output)

    def test_json_output_carries_the_origin(self) -> None:
        with mock.patch("agentrail.cli.commands.context.wiki_client.remote_status", return_value=_SERVER_STATUS):
            payload = json.loads(_run("status", "--json", "--target", _target()))
        self.assertEqual(payload["origin"], "server")


class ShowTests(unittest.TestCase):
    def test_prints_the_server_page_text(self) -> None:
        page = {"found": True, "slug": "wiki/overview", "file": None, "origin": "server",
                "frontmatter": {}, "body": "b", "text": "---\nslug: wiki/overview\n---\n\nbody\n"}
        with mock.patch("agentrail.cli.commands.context.wiki_client.remote_show", return_value=page):
            output = _run("show", "wiki/overview", "--target", _target())
        self.assertEqual(output, page["text"])

    def test_unknown_slug_lists_the_available_ones(self) -> None:
        """The slug-discovery story: unit slugs are `wiki/unit/<unit-id>`,
        unguessable by construction, and the gather fence forbids grep — so a
        miss has to hand back the real list or the agent is stuck."""
        miss = {"found": False, "slug": "wiki/unit/nope", "slugs": ["wiki/overview", "wiki/unit/core"]}
        with mock.patch("agentrail.cli.commands.context.wiki_client.remote_show", return_value=miss):
            with self.assertRaises(SystemExit) as caught:
                _run_wiki(["show", "wiki/unit/nope", "--target", _target()])
        message = str(caught.exception)
        self.assertIn("no wiki page for slug", message)
        self.assertIn("wiki/unit/core", message)

    def test_server_outage_falls_back_to_the_local_reader(self) -> None:
        with mock.patch("agentrail.cli.commands.context.wiki_client.remote_show", return_value=None):
            with self.assertRaises(SystemExit) as caught:
                _run_wiki(["show", "wiki/overview", "--target", _target()])
        # The LOCAL reader's error, not the server's — proof the fallback ran.
        self.assertIn("looked for", str(caught.exception))


class SearchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.pages = [{"slug": "wiki/unit/billing", "title": "billing", "bodyMd": "Handles invoices.", "stale": False}]

    def test_ranks_server_pages_and_points_at_the_read_command(self) -> None:
        with mock.patch("agentrail.cli.commands.context.wiki_client.remote_pages", return_value=self.pages):
            output = _run("search", "billing", "--target", _target())
        self.assertIn("wiki/unit/billing", output)
        self.assertIn("agentrail context wiki show wiki/unit/billing", output)

    def test_falls_back_to_local_pages(self) -> None:
        with mock.patch("agentrail.cli.commands.context.wiki_client.remote_pages", return_value=None), \
             mock.patch("agentrail.cli.commands.context.wiki_client.local_pages", return_value=self.pages) as local:
            output = _run("search", "billing", "--json", "--target", _target())
        local.assert_called_once()
        self.assertEqual(json.loads(output)["origin"], "local")

    def test_no_pages_anywhere_explains_both_possible_causes(self) -> None:
        with mock.patch("agentrail.cli.commands.context.wiki_client.remote_pages", return_value=None), \
             mock.patch("agentrail.cli.commands.context.wiki_client.local_pages", return_value=[]):
            output = _run("search", "billing", "--target", _target())
        self.assertIn("not be linked", output)
        self.assertIn("wiki build", output)

    def test_a_query_that_matches_nothing_says_how_many_pages_it_searched(self) -> None:
        with mock.patch("agentrail.cli.commands.context.wiki_client.remote_pages", return_value=self.pages):
            output = _run("search", "kubernetes", "--target", _target())
        self.assertIn("No wiki page matches", output)
        self.assertIn("1 pages", output)

    def test_limit_is_passed_through(self) -> None:
        pages = [{"slug": f"wiki/unit/{i}", "title": "billing", "bodyMd": "x", "stale": False} for i in range(9)]
        with mock.patch("agentrail.cli.commands.context.wiki_client.remote_pages", return_value=pages):
            payload = json.loads(_run("search", "billing", "--limit", "2", "--json", "--target", _target()))
        self.assertEqual(len(payload["results"]), 2)

    def test_missing_query_is_rejected(self) -> None:
        with self.assertRaises(SystemExit) as caught:
            _run_wiki(["search", "--json"])
        self.assertIn("requires a query", str(caught.exception))

    def test_non_numeric_limit_is_rejected(self) -> None:
        with self.assertRaises(SystemExit) as caught:
            _run_wiki(["search", "billing", "--limit", "many"])
        self.assertIn("must be a number", str(caught.exception))

    def test_limit_is_rejected_on_other_actions(self) -> None:
        with self.assertRaises(SystemExit) as caught:
            _run_wiki(["status", "--limit", "2"])
        self.assertIn("only valid for context wiki search", str(caught.exception))


class DispatchTests(unittest.TestCase):
    def test_unknown_action_names_search_among_the_options(self) -> None:
        with self.assertRaises(SystemExit) as caught:
            _run_wiki(["explode"])
        self.assertIn("search", str(caught.exception))

    def test_no_action_names_search_among_the_options(self) -> None:
        with self.assertRaises(SystemExit) as caught:
            _run_wiki([])
        self.assertIn("search", str(caught.exception))


if __name__ == "__main__":
    unittest.main()

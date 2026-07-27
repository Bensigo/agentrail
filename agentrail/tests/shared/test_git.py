"""Tests for agentrail/shared/git.py's origin_repo_full_name.

Context source registry spec, section G
(docs/superpowers/specs/2026-07-27-context-source-registry-design.md): this
helper moved here from agentrail.cli.commands.context._origin_repo_full_name
so the CLI's `context index` push path and the coming server-backed wiki
source resolve a repo's owner/repo the same way.

These are the SAME six cases agentrail/tests/cli/test_context_cli.py's
OriginRepoFullNameTests already exercised against the old private CLI
function, run here against the new shared home — real local git repos (git
remote add origin), not a mocked subprocess, since the resolution is cheap
and local. Plus one identity check proving the CLI's `_origin_repo_full_name`
name is a straight re-export of this function, not a second copy that could
drift.
"""
from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from agentrail.shared.git import origin_repo_full_name


class OriginRepoFullNameTests(unittest.TestCase):
    def _repo_with_origin(self, url: str | None) -> Path:
        root = Path(tempfile.mkdtemp())
        subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
        if url is not None:
            subprocess.run(["git", "-C", str(root), "remote", "add", "origin", url], check=True)
        return root

    def test_https_origin_resolves_lowercase_owner_repo(self) -> None:
        root = self._repo_with_origin("https://github.com/Acme/Widgets.git")
        self.assertEqual(origin_repo_full_name(root), "acme/widgets")

    def test_https_origin_without_dot_git_suffix_also_resolves(self) -> None:
        root = self._repo_with_origin("https://github.com/acme/widgets")
        self.assertEqual(origin_repo_full_name(root), "acme/widgets")

    def test_ssh_origin_resolves_the_same_slug_as_https(self) -> None:
        root = self._repo_with_origin("git@github.com:acme/widgets.git")
        self.assertEqual(origin_repo_full_name(root), "acme/widgets")

    def test_no_origin_remote_returns_none(self) -> None:
        root = self._repo_with_origin(None)
        self.assertIsNone(origin_repo_full_name(root))

    def test_non_github_origin_returns_none(self) -> None:
        root = self._repo_with_origin("https://gitlab.com/acme/widgets.git")
        self.assertIsNone(origin_repo_full_name(root))

    def test_not_a_git_checkout_returns_none(self) -> None:
        root = Path(tempfile.mkdtemp())  # never git-inited
        self.assertIsNone(origin_repo_full_name(root))

    def test_cli_private_name_is_the_same_function_not_a_copy(self) -> None:
        """Parity guard: agentrail.cli.commands.context._origin_repo_full_name
        must be a re-export of THIS function, never a second implementation
        that could silently drift from it."""
        from agentrail.cli.commands.context import _origin_repo_full_name

        self.assertIs(_origin_repo_full_name, origin_repo_full_name)


if __name__ == "__main__":
    unittest.main()

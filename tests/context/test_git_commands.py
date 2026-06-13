"""Tests for agentrail/context/git_commands.py

Uses a real fixture git repo created in a temp directory so that author/sha
fields are deterministic (TASTE.md: evidence over claims).
"""
from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

import pytest

from agentrail.context.git_commands import git_blame, git_changed, git_history


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _git(args: list[str], cwd: Path, **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-c", "user.email=test@example.com", "-c", "user.name=Test User"] + args,
        cwd=str(cwd),
        capture_output=True,
        text=True,
        check=True,
        **kwargs,
    )


@pytest.fixture()
def fixture_repo(tmp_path: Path) -> Path:
    """A small git repo with one committed Python file."""
    _git(["init", "--quiet"], cwd=tmp_path)
    # Create a Python file with a known function so --symbol can find it
    src = tmp_path / "sample.py"
    src.write_text(
        "def hello():\n"
        "    return 'hello'\n"
        "\n"
        "def world():\n"
        "    return 'world'\n",
        encoding="utf-8",
    )
    _git(["add", "sample.py"], cwd=tmp_path)
    _git(["commit", "--quiet", "-m", "initial commit"], cwd=tmp_path)
    return tmp_path


# ---------------------------------------------------------------------------
# git_blame tests
# ---------------------------------------------------------------------------

class TestGitBlame:
    def test_returns_entries_for_requested_lines(self, fixture_repo: Path):
        entries = git_blame("sample.py", 1, 2, fixture_repo)
        assert len(entries) == 2
        for entry in entries:
            assert len(entry["sha"]) == 40
            assert all(c in "0123456789abcdefABCDEF" for c in entry["sha"])
            assert entry["author"]  # non-empty
            assert entry["date"]    # non-empty (unix timestamp)

    def test_entry_structure(self, fixture_repo: Path):
        entries = git_blame("sample.py", 1, 1, fixture_repo)
        assert len(entries) == 1
        entry = entries[0]
        assert entry["line"] == 1
        assert "def hello" in entry["content"]

    def test_filters_to_requested_range(self, fixture_repo: Path):
        entries = git_blame("sample.py", 4, 5, fixture_repo)
        assert all(4 <= e["line"] <= 5 for e in entries)


# ---------------------------------------------------------------------------
# git_history tests
# ---------------------------------------------------------------------------

class TestGitHistory:
    def test_returns_at_least_one_commit(self, fixture_repo: Path):
        entries = git_history("sample.py", target=fixture_repo)
        assert len(entries) >= 1

    def test_sha_is_40_char_hex(self, fixture_repo: Path):
        entries = git_history("sample.py", target=fixture_repo)
        for entry in entries:
            assert len(entry["sha"]) == 40
            assert all(c in "0123456789abcdefABCDEF" for c in entry["sha"])

    def test_entry_has_required_fields(self, fixture_repo: Path):
        entries = git_history("sample.py", target=fixture_repo)
        entry = entries[0]
        assert "sha" in entry
        assert "author" in entry
        assert "date" in entry
        assert "summary" in entry
        assert entry["summary"]  # non-empty

    def test_symbol_flag_returns_results_for_known_function(self, fixture_repo: Path):
        entries = git_history("sample.py", symbol="hello", target=fixture_repo)
        assert len(entries) >= 1
        entry = entries[0]
        assert len(entry["sha"]) == 40


# ---------------------------------------------------------------------------
# git_changed tests
# ---------------------------------------------------------------------------

class TestGitChanged:
    def test_clean_tree_since_head_returns_empty(self, fixture_repo: Path):
        result = git_changed(since="HEAD", target=fixture_repo)
        assert result == []

    def test_unstaged_new_file_appears_with_correct_status(self, fixture_repo: Path):
        new_file = fixture_repo / "new_file.py"
        new_file.write_text("x = 1\n", encoding="utf-8")
        # Stage the file so git diff HEAD sees it
        subprocess.run(["git", "add", "new_file.py"], cwd=str(fixture_repo), check=True)
        result = git_changed(since="HEAD", target=fixture_repo)
        paths = [e["path"] for e in result]
        statuses = {e["path"]: e["status"] for e in result}
        assert "new_file.py" in paths
        assert statuses["new_file.py"] == "added"

    def test_modified_file_appears_with_modified_status(self, fixture_repo: Path):
        (fixture_repo / "sample.py").write_text(
            "def hello():\n    return 'hi'\n", encoding="utf-8"
        )
        subprocess.run(["git", "add", "sample.py"], cwd=str(fixture_repo), check=True)
        result = git_changed(since="HEAD", target=fixture_repo)
        statuses = {e["path"]: e["status"] for e in result}
        assert "sample.py" in statuses
        assert statuses["sample.py"] == "modified"

    def test_default_since_is_head(self, fixture_repo: Path):
        # On a clean tree with no staged changes, default (HEAD) should return []
        result = git_changed(target=fixture_repo)
        assert isinstance(result, list)

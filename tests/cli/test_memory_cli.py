"""Tests for ``agentrail memory`` command (native recall/capture, M5)."""
from __future__ import annotations

import datetime
import io
import re
import subprocess
import tempfile
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch


def _make_git_repo_with_memory() -> str:
    """Create a temp git repo with a docs/memory fixture."""
    tmp = tempfile.mkdtemp()
    subprocess.run(["git", "init", "-q", tmp], check=True)
    mem = Path(tmp) / "docs" / "memory"
    mem.mkdir(parents=True)
    (mem / "decisions.md").write_text(
        "# Decisions\n"
        "\n"
        "## Prefer server-side validation\n"
        "\n"
        "- kind: decision\n"
        "\n"
        "Keep validation rules server-side when they affect persisted business state.\n"
    )
    return tmp


# ----------------------------------------------------------------------
# CLI dispatch — run_memory
# ----------------------------------------------------------------------
class TestRunMemoryDispatch(TestCase):
    def test_empty_args_returns_1(self):
        from agentrail.cli.commands.memory import run_memory

        buf = io.StringIO()
        with patch("sys.stderr", buf):
            rc = run_memory([])
        self.assertEqual(rc, 1)
        self.assertIn("Usage", buf.getvalue())

    def test_help_short_returns_0(self):
        from agentrail.cli.commands.memory import run_memory

        buf = io.StringIO()
        with patch("sys.stdout", buf):
            rc = run_memory(["-h"])
        self.assertEqual(rc, 0)
        self.assertIn("Usage", buf.getvalue())

    def test_help_long_returns_0(self):
        from agentrail.cli.commands.memory import run_memory

        buf = io.StringIO()
        with patch("sys.stdout", buf):
            rc = run_memory(["--help"])
        self.assertEqual(rc, 0)
        self.assertIn("Usage", buf.getvalue())

    def test_recall_routes_to_memory_recall_with_target_cwd(self):
        from agentrail.cli.commands import memory as memcli

        with patch.object(memcli, "memory_recall", return_value=("hit", 0)) as mr:
            rc = memcli.run_memory(["recall", "billing", "validation", "--target", "/x"])
        self.assertEqual(rc, 0)
        mr.assert_called_once_with("billing validation", "/x")

    def test_recall_prints_text(self):
        from agentrail.cli.commands import memory as memcli

        buf = io.StringIO()
        with patch.object(memcli, "memory_recall", return_value=("the-output", 0)), \
             patch("sys.stdout", buf):
            rc = memcli.run_memory(["recall", "q"])
        self.assertEqual(rc, 0)
        self.assertIn("the-output", buf.getvalue())

    def test_recall_no_query_returns_1(self):
        from agentrail.cli.commands import memory as memcli

        buf = io.StringIO()
        with patch("sys.stderr", buf):
            rc = memcli.run_memory(["recall"])
        self.assertEqual(rc, 1)

    def test_capture_routes_to_memory_capture(self):
        from agentrail.cli.commands import memory as memcli

        buf = io.StringIO()
        with patch.object(memcli, "memory_capture", return_value="TEMPLATE") as mc, \
             patch("sys.stdout", buf):
            rc = memcli.run_memory(["capture", "lesson", "Normalize", "emails"])
        self.assertEqual(rc, 0)
        mc.assert_called_once_with("lesson", "Normalize emails")
        self.assertIn("TEMPLATE", buf.getvalue())

    def test_new_alias_routes_to_capture(self):
        from agentrail.cli.commands import memory as memcli

        with patch.object(memcli, "memory_capture", return_value="T") as mc:
            rc = memcli.run_memory(["new", "decision", "Title here"])
        self.assertEqual(rc, 0)
        mc.assert_called_once_with("decision", "Title here")

    def test_capture_missing_title_returns_1(self):
        from agentrail.cli.commands import memory as memcli

        buf = io.StringIO()
        with patch("sys.stderr", buf):
            rc = memcli.run_memory(["capture", "lesson"])
        self.assertEqual(rc, 1)

    def test_unknown_subcommand_returns_2(self):
        from agentrail.cli.commands import memory as memcli

        buf = io.StringIO()
        with patch("sys.stderr", buf):
            rc = memcli.run_memory(["bogus", "arg"])
        self.assertEqual(rc, 2)
        self.assertIn("Usage", buf.getvalue())

    def test_target_missing_value_returns_2(self):
        from agentrail.cli.commands.memory import run_memory

        buf = io.StringIO()
        with patch("sys.stderr", buf):
            rc = run_memory(["recall", "--target"])
        self.assertEqual(rc, 2)
        self.assertIn("--target requires a directory", buf.getvalue())

    def test_target_followed_by_flag_returns_2(self):
        from agentrail.cli.commands.memory import run_memory

        buf = io.StringIO()
        with patch("sys.stderr", buf):
            rc = run_memory(["recall", "--target", "--other"])
        self.assertEqual(rc, 2)
        self.assertIn("--target requires a directory", buf.getvalue())

    def test_help_in_rest_returns_0(self):
        from agentrail.cli.commands.memory import run_memory

        buf = io.StringIO()
        with patch("sys.stdout", buf):
            rc = run_memory(["recall", "-h"])
        self.assertEqual(rc, 0)
        self.assertIn("Usage", buf.getvalue())

    def test_main_routes_memory(self):
        import agentrail.cli.main as m

        with patch("agentrail.cli.main.run_memory", return_value=0) as mock_rm:
            rc = m.main(["memory", "recall", "query"])
        mock_rm.assert_called_once_with(["recall", "query"])
        self.assertEqual(rc, 0)


# ----------------------------------------------------------------------
# Native recall
# ----------------------------------------------------------------------
class TestMemoryRecall(TestCase):
    def test_exact_phrase_hit(self):
        from agentrail.cli.commands.memory_core import memory_recall

        tmp = _make_git_repo_with_memory()
        text, rc = memory_recall("Prefer server-side validation", tmp)
        self.assertEqual(rc, 0)
        self.assertIn("Prefer server-side validation", text)
        # raw grep style: relpath:lineno:line for the match
        self.assertRegex(text, r"docs/memory/decisions\.md:\d+:")

    def test_multi_term_non_adjacent_hit(self):
        from agentrail.cli.commands.memory_core import memory_recall

        tmp = _make_git_repo_with_memory()
        # "persisted validation" is not a contiguous phrase; pass-2 per-term OR
        text, rc = memory_recall("persisted validation", tmp)
        self.assertEqual(rc, 0)
        self.assertIn("Prefer server-side validation", text)

    def test_bracketed_literal_not_regex(self):
        from agentrail.cli.commands.memory_core import memory_recall

        tmp = tempfile.mkdtemp()
        subprocess.run(["git", "init", "-q", tmp], check=True)
        mem = Path(tmp) / "docs" / "memory"
        mem.mkdir(parents=True)
        (mem / "lessons.md").write_text(
            "# Lessons\n\n## [codex] Bracketed PR titles stay literal\n\nRecall queries.\n"
        )
        text, rc = memory_recall("[codex]", tmp)
        self.assertEqual(rc, 0)
        self.assertIn("Bracketed PR titles stay literal", text)

    def test_no_memory_dir_message(self):
        from agentrail.cli.commands.memory_core import memory_recall

        tmp = tempfile.mkdtemp()
        subprocess.run(["git", "init", "-q", tmp], check=True)
        text, rc = memory_recall("anything", tmp)
        self.assertEqual(rc, 0)
        self.assertEqual(text, "No docs/memory directory found.")

    def test_empty_result(self):
        from agentrail.cli.commands.memory_core import memory_recall

        tmp = _make_git_repo_with_memory()
        text, rc = memory_recall("zzzznotpresent", tmp)
        self.assertEqual(rc, 0)
        self.assertEqual(text, "")

    def test_context_window(self):
        from agentrail.cli.commands.memory_core import memory_recall

        tmp = _make_git_repo_with_memory()
        text, rc = memory_recall("persisted business state", tmp)
        self.assertEqual(rc, 0)
        # context lines rendered with '-' separator
        self.assertRegex(text, r"docs/memory/decisions\.md-\d+-")


# ----------------------------------------------------------------------
# Native capture
# ----------------------------------------------------------------------
class TestMemoryCapture(TestCase):
    def test_template_shape(self):
        from agentrail.cli.commands.memory_core import memory_capture

        out = memory_capture("lesson", "My Title")
        self.assertIn("## My Title", out)
        self.assertIn("- kind: lesson", out)
        self.assertIn("- source:", out)
        self.assertIn("- confidence: verified", out)
        self.assertIn("- expires_at:", out)

    def test_created_at_is_today_format(self):
        from agentrail.cli.commands.memory_core import memory_capture

        out = memory_capture("decision", "X")
        m = re.search(r"- created_at: (\d{4}-\d{2}-\d{2})", out)
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), datetime.date.today().isoformat())

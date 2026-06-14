from __future__ import annotations

import re
import subprocess
import tempfile
import unittest
from pathlib import Path

from agentrail.context.git_commands import git_blame, git_changed, git_history


SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def _run(root: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(root), *args], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class GitCommandsTests(unittest.TestCase):
    def make_repo(self) -> Path:
        root = Path(tempfile.mkdtemp())
        _run(root, "init", "--quiet")
        _run(root, "config", "user.email", "fixture@example.com")
        _run(root, "config", "user.name", "Fixture Author")
        (root / "sample.py").write_text(
            "def greet(name):\n"
            "    return f\"hello {name}\"\n"
            "\n"
            "\n"
            "def farewell(name):\n"
            "    return f\"bye {name}\"\n",
            encoding="utf-8",
        )
        _run(root, "add", "sample.py")
        _run(root, "commit", "--quiet", "-m", "add sample")
        return root

    def test_blame_returns_author_and_sha(self):
        root = self.make_repo()
        result = git_blame(root, "sample.py", 1, 2)
        self.assertEqual(len(result), 2)
        for entry in result:
            self.assertTrue(entry["author"])
            self.assertTrue(SHA_RE.match(entry["sha"]))
            self.assertIsInstance(entry["line"], int)
            self.assertIn("content", entry)
            self.assertTrue(entry["date"])
        self.assertEqual(result[0]["line"], 1)
        self.assertEqual(result[1]["line"], 2)

    def test_history_returns_commit(self):
        root = self.make_repo()
        result = git_history(root, "sample.py")
        self.assertGreaterEqual(len(result), 1)
        entry = result[0]
        self.assertTrue(SHA_RE.match(entry["sha"]))
        self.assertTrue(entry["author"])
        self.assertTrue(entry["date"])
        self.assertTrue(entry["summary"])

    def test_history_symbol_filter(self):
        root = self.make_repo()
        result = git_history(root, "sample.py", symbol="greet")
        self.assertGreaterEqual(len(result), 1)
        self.assertTrue(SHA_RE.match(result[0]["sha"]))

    def test_history_parity_author_date_format(self):
        """Both paths must return the same author (email-only) and date (%ai) format."""
        EMAIL_RE = re.compile(r"^[^@\s<>]+@[^@\s<>]+$")
        # %ai format: "YYYY-MM-DD HH:MM:SS +HHMM"
        DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}$")

        root = self.make_repo()
        regular = git_history(root, "sample.py")
        symbol = git_history(root, "sample.py", symbol="greet")

        self.assertGreaterEqual(len(regular), 1)
        self.assertGreaterEqual(len(symbol), 1)

        # The fixture has one commit that touches both the file and greet.
        # Find the shared SHA and compare field values directly.
        regular_by_sha = {e["sha"]: e for e in regular}
        for sym_entry in symbol:
            sha = sym_entry["sha"]
            self.assertIn(sha, regular_by_sha, f"symbol SHA {sha} not found in regular history")
            reg_entry = regular_by_sha[sha]
            self.assertEqual(sym_entry["author"], reg_entry["author"], "author fields differ")
            self.assertEqual(sym_entry["date"], reg_entry["date"], "date fields differ")
            # Verify the actual format (email-only, no angle brackets or spaces)
            self.assertRegex(sym_entry["author"], EMAIL_RE, "author must be email-only")
            self.assertRegex(sym_entry["date"], DATE_RE, "date must be %ai format")

    def test_changed_clean_tree_empty(self):
        root = self.make_repo()
        self.assertEqual(git_changed(root, since="HEAD"), [])

    def test_changed_after_write(self):
        root = self.make_repo()
        (root / "sample.py").write_text("def greet(name):\n    return name\n", encoding="utf-8")
        result = git_changed(root, since="HEAD")
        self.assertIn({"path": "sample.py", "status": "modified"}, result)

    def test_changed_after_delete(self):
        root = self.make_repo()
        (root / "sample.py").unlink()
        result = git_changed(root, since="HEAD")
        self.assertIn({"path": "sample.py", "status": "deleted"}, result)


if __name__ == "__main__":
    unittest.main()

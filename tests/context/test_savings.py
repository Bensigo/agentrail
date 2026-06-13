from __future__ import annotations

import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from agentrail.cli.commands.context import run_context


def _write_pack(packs_dir: Path, pack_id: str, generated_at: str, items: list[dict]) -> None:
    pack = {
        "packId": pack_id,
        "generatedAt": generated_at,
        "included": items,
    }
    (packs_dir / f"{pack_id}.json").write_text(json.dumps(pack, indent=2), encoding="utf-8")


class ContextSavingsTests(unittest.TestCase):
    def _make_root(self) -> Path:
        root = Path(tempfile.mkdtemp())
        (root / ".agentrail" / "context" / "packs").mkdir(parents=True)
        return root

    def _make_pack_with_savings(self, root: Path, pack_id: str, generated_at: str) -> None:
        # A real file under root with far more content than the bounded snippet.
        target_file = root / "big.py"
        target_file.write_text("x = 1\n" * 500, encoding="utf-8")
        packs_dir = root / ".agentrail" / "context" / "packs"
        _write_pack(
            packs_dir,
            pack_id,
            generated_at,
            [{"path": "big.py", "content": "x = 1\n"}],
        )

    def _run_json(self, root: Path) -> dict:
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = run_context(["savings", "--target", str(root), "--json"])
        self.assertEqual(code, 0)
        return json.loads(buffer.getvalue())

    def test_non_negative_integer_with_pack(self) -> None:
        root = self._make_root()
        self._make_pack_with_savings(root, "issue-1-plan-20260101T000000000Z", "2026-01-01T00:00:00.000Z")
        result = self._run_json(root)
        self.assertIsInstance(result["tokensSaved"], int)
        self.assertGreater(result["tokensSaved"], 0)

    def test_json_schema(self) -> None:
        root = self._make_root()
        self._make_pack_with_savings(root, "issue-1-plan-20260101T000000000Z", "2026-01-01T00:00:00.000Z")
        result = self._run_json(root)
        self.assertEqual(set(result.keys()), {"tokensSaved", "sessions"})
        self.assertIsInstance(result["tokensSaved"], int)
        self.assertIsInstance(result["sessions"], list)
        session = result["sessions"][0]
        self.assertEqual(set(session.keys()), {"packId", "generatedAt", "tokensSaved"})
        self.assertIsInstance(session["packId"], str)
        self.assertIsInstance(session["generatedAt"], str)
        self.assertIsInstance(session["tokensSaved"], int)

    def test_sessions_sorted_newest_first(self) -> None:
        root = self._make_root()
        (root / "big.py").write_text("x = 1\n" * 500, encoding="utf-8")
        packs_dir = root / ".agentrail" / "context" / "packs"
        items = [{"path": "big.py", "content": "x = 1\n"}]
        _write_pack(packs_dir, "older", "2026-01-01T00:00:00.000Z", items)
        _write_pack(packs_dir, "newer", "2026-06-01T00:00:00.000Z", items)
        result = self._run_json(root)
        order = [s["packId"] for s in result["sessions"]]
        self.assertEqual(order, ["newer", "older"])

    def test_empty_packs(self) -> None:
        root = self._make_root()
        result = self._run_json(root)
        self.assertEqual(result["tokensSaved"], 0)
        self.assertEqual(result["sessions"], [])

    def test_no_packs_dir(self) -> None:
        root = Path(tempfile.mkdtemp())
        result = self._run_json(root)
        self.assertEqual(result["tokensSaved"], 0)
        self.assertEqual(result["sessions"], [])

    def test_text_output(self) -> None:
        root = self._make_root()
        self._make_pack_with_savings(root, "issue-1-plan-20260101T000000000Z", "2026-01-01T00:00:00.000Z")
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = run_context(["savings", "--target", str(root)])
        self.assertEqual(code, 0)
        out = buffer.getvalue()
        self.assertIn("tokensSaved:", out)
        self.assertIn("issue-1-plan-20260101T000000000Z", out)


if __name__ == "__main__":
    unittest.main()

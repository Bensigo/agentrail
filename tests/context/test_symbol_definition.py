from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from agentrail.context.index import build_index
from agentrail.context.retrieval import query_context


def make_repo() -> Path:
    root = Path(tempfile.mkdtemp())
    subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
    (root / ".agentrail").mkdir()
    (root / ".agentrail" / "config.json").write_text(json.dumps({
        "schemaVersion": 1,
        "context": {
            "includeGlobs": ["**/*"],
            "excludeGlobs": [".git/**", ".agentrail/context/**"],
            "maxFileSizeBytes": 262144,
            "skipBinary": True,
            "respectGitIgnore": True,
            "secretRedaction": {"enabled": False, "action": "exclude", "denyGlobs": []},
            "embedding": {"mode": "disabled", "provider": None, "model": None},
            "summary": {"mode": "disabled", "provider": None, "model": None},
        },
    }, indent=2), encoding="utf-8")
    (root / "lib").mkdir()
    # Defines settleInvoice once.
    (root / "lib" / "ledger.js").write_text(
        "function settleInvoice(id){\n  return id;\n}\nmodule.exports = { settleInvoice };\n",
        encoding="utf-8")
    # Calls settleInvoice many times (would win on raw BM25).
    (root / "lib" / "worker.js").write_text(
        "settleInvoice(1); settleInvoice(2); settleInvoice(3); settleInvoice(4);\n",
        encoding="utf-8")
    return root


class SymbolDefinitionRankingTests(unittest.TestCase):
    def test_defining_file_outranks_caller(self) -> None:
        root = make_repo()
        build_index(root)
        out = query_context(root, "settleInvoice", limit=6)
        paths = [r["path"] for r in out["results"]]
        self.assertIn("lib/ledger.js", paths)
        self.assertLess(
            paths.index("lib/ledger.js"),
            paths.index("lib/worker.js"),
            f"defining file should rank above caller; got order {paths}",
        )

    def test_definition_reason_recorded(self) -> None:
        root = make_repo()
        build_index(root)
        out = query_context(root, "settleInvoice", limit=6)
        top = next(r for r in out["results"] if r["path"] == "lib/ledger.js")
        self.assertIn("symbol definition", top["reason"])


if __name__ == "__main__":
    unittest.main()

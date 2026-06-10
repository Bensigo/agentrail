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

    def test_definition_outranks_dense_reference_files(self) -> None:
        # Mirrors Express: many short test/usage files densely repeat the symbol
        # (high BM25) and would otherwise bury the single definition site.
        root = make_repo()
        # Long definition file (BM25 diluted by length, like Express's response.js)
        filler = "\n".join(f"function other_{n}(){{ return {n}; }}" for n in range(120))
        (root / "lib" / "ledger.js").write_text(
            f"function settleInvoice(id){{ return id; }}\n{filler}\nmodule.exports = {{ settleInvoice }};\n",
            encoding="utf-8")
        # Short reference files densely repeating the symbol (high BM25, like tests)
        for i in range(6):
            (root / "lib" / f"usage_{i}.js").write_text(
                " ".join(["settleInvoice();"] * 12) + "\n", encoding="utf-8")
        build_index(root)
        out = query_context(root, "settleInvoice", limit=10)
        paths = [r["path"] for r in out["results"]]
        self.assertEqual(paths[0], "lib/ledger.js",
                         f"definition site must rank #1 over dense reference files; got {paths[:4]}")

    def test_dotted_member_definition_outranks_callers_and_namesakes(self) -> None:
        # "res.json" must rank the file assigning res.json, above dense callers
        # AND above a file that defines an unrelated same-named member (express.json).
        root = make_repo()
        (root / "lib" / "response.js").write_text(
            "var res = {};\nres.json = function json(obj){ return JSON.stringify(obj); };\n", encoding="utf-8")
        (root / "lib" / "express_json.js").write_text(
            "exports.json = function json(opts){ return middleware; };\n" * 4, encoding="utf-8")
        for i in range(5):
            (root / "lib" / f"caller_{i}.js").write_text(
                " ".join(["res.json({});"] * 10) + "\n", encoding="utf-8")
        build_index(root)
        out = query_context(root, "res.json", limit=10)
        paths = [r["path"] for r in out["results"]]
        self.assertEqual(paths[0], "lib/response.js",
                         f"dotted-member definition must rank #1; got {paths[:4]}")

    def test_definition_reason_recorded(self) -> None:
        root = make_repo()
        build_index(root)
        out = query_context(root, "settleInvoice", limit=6)
        top = next(r for r in out["results"] if r["path"] == "lib/ledger.js")
        self.assertIn("symbol definition", top["reason"])


if __name__ == "__main__":
    unittest.main()

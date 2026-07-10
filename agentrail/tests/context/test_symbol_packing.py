"""Acceptance tests for issue #1044 AC4 — symbol-range packing (default OFF).

Behind ``AGENTRAIL_CONTEXT_SYMBOL_PACKING`` (default OFF), ``build_context_pack``
replaces each symbol-bearing code candidate's ``content`` with the symbol's
exact line range from the index symbol table, sets ``lineStart``/``lineEnd``,
keeps ``citation`` as ``path#symbol``, and recomputes ``tokenEstimate`` from the
packed snippet only.  It NEVER changes a candidate's ``path`` and NEVER drops a
candidate — item selection is identical ON vs OFF, so precision/recall
semantics are untouched (packing shrinks tokens, not the candidate set).

RED (before the packs.py implementation): ``symbol_packing_enabled`` does not
exist, so this module fails at import.
"""
from __future__ import annotations

import copy
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from agentrail.context.evaluation import evaluate_retrieval
from agentrail.context.index import build_index, load_index
from agentrail.context.packs import (
    build_context_pack,
    load_context_pack,
    symbol_packing_enabled,
)
from agentrail.context.retrieval import estimate_tokens

REPO_ROOT = Path(__file__).parent.parent.parent.parent
RETRIEVAL_FIXTURE_FILE = REPO_ROOT / "agentrail" / "context" / "retrieval-fixtures.json"

_FLAG = "AGENTRAIL_CONTEXT_SYMBOL_PACKING"


@contextmanager
def _env(key: str, value: str | None):
    """Temporarily set (or unset, for value=None) an env var."""
    prev = os.environ.get(key)
    if value is None:
        os.environ.pop(key, None)
    else:
        os.environ[key] = value
    try:
        yield
    finally:
        if prev is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = prev


def _symbol_packing(enabled: bool):
    return _env(_FLAG, "1" if enabled else "0")


# The pack query is fixed ("... context pack required context likely files docs
# memory prior mistakes active state tools skills excluded context open
# questions"), so the fixture's answer symbol repeats those words to be
# retrieved lexically as a code candidate.
_PLANNER_SOURCE = '''def plan_pack(target):
    """Plan the context pack for a target issue.

    Covers required context, likely files, docs, memory, prior mistakes,
    active state, tools, skills, excluded context and open questions.
    """
    sections = [
        "required context",
        "likely files",
        "docs",
        "memory",
        "prior mistakes",
        "active state",
        "tools",
        "skills",
        "excluded context",
        "open questions",
    ]
    return {"target": target, "sections": sections}


def rolling_checksum(payload):
    """Rolling checksum over raw bytes; lexical filler unrelated to packs."""
    total = 0
    for byte in payload:
        total = (total * 31 + byte) % 65521
    return total
'''


def _make_repo() -> Path:
    """Tiny git repo whose built index has a symbol-bearing code candidate that
    the fixed pack query retrieves."""
    root = Path(tempfile.mkdtemp())
    (root / ".agentrail").mkdir()
    (root / ".agentrail" / "config.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "context": {
                    "includeGlobs": ["**/*"],
                    "excludeGlobs": [".git/**", ".agentrail/context/**"],
                    "maxFileSizeBytes": 262144,
                    "skipBinary": True,
                    "respectGitIgnore": True,
                    "secretRedaction": {"enabled": False, "action": "exclude", "denyGlobs": []},
                    "embedding": {"mode": "disabled"},
                    "summary": {"mode": "disabled"},
                },
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    (root / "CONTEXT.md").write_text(
        "# Context\n\nContext pack symbol packing quality gate.\n", encoding="utf-8"
    )
    src = root / "agentrail"
    src.mkdir()
    (src / "planner.py").write_text(_PLANNER_SOURCE, encoding="utf-8")
    subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.email", "t@t.com"], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.name", "t"], check=True)
    subprocess.run(["git", "-C", str(root), "add", "."], check=True)
    subprocess.run(["git", "-C", str(root), "commit", "--quiet", "-m", "init"], check=True)
    build_index(root)
    return root


def _build_pack(root: Path) -> dict:
    """Build a pack (rerank pinned OFF for determinism, same in every arm) and
    load the persisted JSON."""
    with _env("AGENTRAIL_CONTEXT_RERANK", "0"):
        result = build_context_pack(root, "issue", 1, "plan")
    return load_context_pack(root, result["packId"])


_VOLATILE_KEYS = {"packId", "generatedAt", "queryGeneratedAt"}


def _canonical(pack: dict) -> str:
    """Pack JSON with volatile identity fields (packId, timestamps, packId-bearing
    paths) normalized so two builds of the same pack compare byte-identical."""
    pack_id = str(pack.get("packId") or "")

    def scrub(value):
        if isinstance(value, dict):
            return {k: scrub(v) for k, v in value.items() if k not in _VOLATILE_KEYS}
        if isinstance(value, list):
            return [scrub(v) for v in value]
        if isinstance(value, str) and pack_id:
            return value.replace(pack_id, "<pack>")
        return value

    return json.dumps(scrub(copy.deepcopy(pack)), sort_keys=True)


def _code_symbol_items(pack: dict) -> list[dict]:
    return [
        item
        for item in pack.get("included", [])
        if isinstance(item, dict)
        and item.get("sourceType") == "code"
        and isinstance(item.get("symbol"), str)
        and item.get("symbol")
    ]


class SymbolPackingFlagTests(unittest.TestCase):
    def test_flag_defaults_off_and_parses_truthy_values(self) -> None:
        with _env(_FLAG, None):
            self.assertFalse(symbol_packing_enabled(), "flag must default OFF when unset")
        for raw in ("0", "false", "off", "no", ""):
            with _env(_FLAG, raw):
                self.assertFalse(symbol_packing_enabled(), f"{raw!r} must be OFF")
        for raw in ("1", "true", "on", "yes", " TRUE "):
            with _env(_FLAG, raw):
                self.assertTrue(symbol_packing_enabled(), f"{raw!r} must be ON")


class SymbolPackingOffIsUnchangedTests(unittest.TestCase):
    """Flag OFF ⇒ byte-identical pack behavior to today."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.repo = _make_repo()

    def test_flag_off_pack_is_identical_to_flag_unset(self) -> None:
        with _env(_FLAG, None):
            unset_pack = _build_pack(self.repo)
        with _symbol_packing(False):
            off_pack = _build_pack(self.repo)
        self.assertEqual(
            _canonical(unset_pack),
            _canonical(off_pack),
            "with the flag OFF the pack must be byte-identical to today's "
            "(flag-unset) behavior — symbol packing must be a strict no-op",
        )
        # No symbol-packing artifacts leak into the OFF pack.
        self.assertNotIn(
            "symbolPacking",
            (off_pack.get("compiler") or {}).get("tokenPack") or {},
            "flag OFF must not emit symbolPacking metadata",
        )
        for item in _code_symbol_items(off_pack):
            self.assertNotIn("lineStart", item, "flag OFF must not add lineStart to candidates")
            self.assertNotIn("lineEnd", item, "flag OFF must not add lineEnd to candidates")


class SymbolPackingOnTests(unittest.TestCase):
    """Flag ON ⇒ symbol-bearing code candidates carry the symbol's exact line
    range; selection (count + paths) is identical to OFF."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.repo = _make_repo()
        with _symbol_packing(False):
            cls.off_pack = _build_pack(cls.repo)
        with _symbol_packing(True):
            cls.on_pack = _build_pack(cls.repo)
        cls.symbol_table = load_index(cls.repo).get("symbolTable") or {}

    def _packable(self, items: list[dict]) -> list[dict]:
        """Items whose explicit symbol resolves in the index symbol table for
        the candidate's own path (the packing contract's precondition)."""
        packable = []
        for item in items:
            records = self.symbol_table.get(item["symbol"]) or []
            if any(
                isinstance(rec, dict)
                and rec.get("path") == item.get("path")
                and rec.get("authority") != "denied"
                for rec in records
            ):
                packable.append(item)
        return packable

    def test_fixture_retrieves_a_symbol_bearing_code_candidate(self) -> None:
        """Precondition guard: the OFF pack must contain at least one code
        candidate with a resolvable symbol, or the packing tests are vacuous."""
        packable = self._packable(_code_symbol_items(self.off_pack))
        self.assertTrue(
            packable,
            "fixture repo must retrieve >=1 code candidate whose symbol resolves "
            "in the index symbolTable — the symbol-packing tests are vacuous "
            f"otherwise; included={[i.get('citation') for i in self.off_pack.get('included', [])]}",
        )

    def test_candidate_selection_is_identical_on_vs_off(self) -> None:
        """Packing must never drop or reorder candidates (protects
        precision/recall semantics): same count, same paths, same citphase order."""
        on_items = self.on_pack.get("included", [])
        off_items = self.off_pack.get("included", [])
        self.assertEqual(
            len(on_items),
            len(off_items),
            "symbol packing must not change the number of included candidates",
        )
        self.assertEqual(
            [(i.get("kind"), i.get("path")) for i in on_items],
            [(i.get("kind"), i.get("path")) for i in off_items],
            "symbol packing must not change candidate paths or order",
        )

    def test_symbol_candidates_are_packed_to_exact_line_ranges(self) -> None:
        packable = self._packable(_code_symbol_items(self.on_pack))
        self.assertTrue(packable, "flag ON pack must still carry the code candidates")
        packed = [item for item in packable if "lineStart" in item]
        self.assertTrue(
            packed,
            "flag ON: symbol-bearing code candidates must be packed to the "
            "symbol's line range (lineStart/lineEnd) — none were",
        )
        for item in packed:
            path = item["path"]
            symbol = item["symbol"]
            file_text = (self.repo / path).read_text(encoding="utf-8")
            file_lines = file_text.splitlines()
            line_start = item["lineStart"]
            line_end = item["lineEnd"]
            self.assertIsInstance(line_start, int)
            self.assertIsInstance(line_end, int)
            self.assertGreaterEqual(line_start, 1)
            self.assertLessEqual(line_end, len(file_lines))
            expected = "\n".join(file_lines[line_start - 1 : line_end])
            self.assertEqual(
                item["content"],
                expected,
                f"{path}#{symbol}: packed content must be exactly lines "
                f"{line_start}..{line_end} of the file",
            )
            self.assertLess(
                len(item["content"]),
                len(file_text),
                f"{path}#{symbol}: packed content must be shorter than the whole file",
            )
            self.assertEqual(
                item["citation"],
                f"{path}#{symbol}",
                "packed candidate citation must be path#symbol",
            )
            self.assertEqual(
                item["tokenEstimate"],
                estimate_tokens(item["content"]),
                "tokenEstimate must be recomputed from the packed snippet only",
            )
            self.assertLess(
                item["tokenEstimate"],
                estimate_tokens(file_text),
                "packed tokenEstimate must be smaller than the whole file's",
            )

    def test_symbol_packing_metadata_is_threaded_into_compiler_contract(self) -> None:
        token_pack = (self.on_pack.get("compiler") or {}).get("tokenPack") or {}
        meta = token_pack.get("symbolPacking")
        self.assertIsInstance(
            meta, dict, "flag ON: compiler.tokenPack must carry symbolPacking metadata"
        )
        self.assertIs(meta.get("enabled"), True)
        packed_count = len(
            [i for i in _code_symbol_items(self.on_pack) if "lineStart" in i]
        )
        self.assertGreaterEqual(packed_count, 1)
        self.assertEqual(
            meta.get("packedCount"),
            packed_count,
            "packedCount must equal the number of line-range-packed candidates",
        )


class SymbolPackingRecallUnchangedTests(unittest.TestCase):
    """Packing shrinks candidate content, never the candidate set: offline
    retrieval recall@10 on the shipped fixtures is unchanged ON vs OFF."""

    def test_recall_at_10_is_unchanged_with_packing_on(self) -> None:
        with _symbol_packing(False):
            baseline = evaluate_retrieval(REPO_ROOT, RETRIEVAL_FIXTURE_FILE)
        with _symbol_packing(True):
            packed = evaluate_retrieval(REPO_ROOT, RETRIEVAL_FIXTURE_FILE)

        base_by_name = {f["name"]: f for f in baseline["fixtures"]}
        compared = 0
        for fixture in packed["fixtures"]:
            if fixture["status"] == "skipped":
                continue
            base = base_by_name[fixture["name"]]
            self.assertEqual(
                fixture["metrics"]["recallAt10"],
                base["metrics"]["recallAt10"],
                f"{fixture['name']}: recall@10 must be unchanged by symbol "
                "packing (it must never drop candidates)",
            )
            compared += 1
        self.assertGreater(compared, 0, "no non-skipped fixtures were compared")


if __name__ == "__main__":
    unittest.main()

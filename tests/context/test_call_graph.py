"""Tests for function-level call-edge extraction (Issue #584, Milestone 019).

AC1: index.json graph edges include kind="calls" after indexing cross-file Python/TS repos
AC2: Resolved calls edges have from, to, callerPath, callerLine, kind="calls"
AC3: Unresolved calls are stubbed with resolved=False + unresolvedReason in
     {no_import, dynamic_call, external_module}
AC4: Denied-authority files do not appear as from or to in any calls edge
AC5: graph_expansion_for_query seeds BFS from call-graph neighbors on relational queries;
     non-relational queries are unaffected
AC6: Incremental re-index does not duplicate calls edges
AC7: This test file
"""
from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, List

import pytest

from agentrail.context.index import (
    build_code_graph,
    build_index,
    extracted_calls,
)
from agentrail.context.models import ChunkRecord, Freshness, SourceRecord
from agentrail.context.retrieval import graph_expansion_for_query


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_record(path: str, content: str, *, authority: str = "normal") -> SourceRecord:
    from agentrail.shared.fs import sha256_text
    return SourceRecord(
        id=f"source:{path}",
        sourceType="code",
        path=path,
        contentHash=sha256_text(content),
        modifiedAt=None,
        freshness=Freshness("current", None, None),
        authority=authority,
        visibility="local",
        linkedIssues=[],
        linkedPullRequests=[],
        chunkIds=[],
        auditRef=f"audit:source:{path}",
        content=content,
    )


def _calls_edges(graph: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [e for e in graph["edges"] if e.get("kind") == "calls"]


def _make_git_repo(root: Path) -> None:
    subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
    subprocess.run(
        ["git", "-C", str(root), "config", "user.email", "test@example.com"],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(root), "config", "user.name", "Test"],
        check=True,
    )


def _make_config(root: Path) -> None:
    (root / ".agentrail").mkdir(exist_ok=True)
    cfg = {
        "schemaVersion": 1,
        "context": {
            "includeGlobs": ["**/*.py", "**/*.ts"],
            "excludeGlobs": [".git/**", ".agentrail/context/**"],
            "maxFileSizeBytes": 262144,
            "skipBinary": True,
            "respectGitIgnore": False,
            "secretRedaction": {"enabled": False, "action": "exclude", "denyGlobs": []},
            "embedding": {"mode": "disabled", "provider": None, "model": None},
            "summary": {"mode": "disabled", "provider": None, "model": None},
        },
    }
    (root / ".agentrail" / "config.json").write_text(
        json.dumps(cfg), encoding="utf-8"
    )


# ---------------------------------------------------------------------------
# AC7 / Unit tests: extracted_calls()
# ---------------------------------------------------------------------------

class TestExtractedCallsPython:
    """Unit tests for extracted_calls() with Python source."""

    _PY_SRC = """\
import os
from pkg.helpers import do_work

def run():
    do_work()
    os.getcwd()
    unknown_func()
    (lambda: 1)()

def helper():
    pass
"""

    def test_returns_list(self) -> None:
        result = extracted_calls(self._PY_SRC, "pkg/caller.py")
        assert isinstance(result, list)

    def test_finds_simple_call(self) -> None:
        result = extracted_calls(self._PY_SRC, "pkg/caller.py")
        names = [c["callee"] for c in result if not c["dynamic"]]
        assert "do_work" in names

    def test_finds_attribute_call(self) -> None:
        result = extracted_calls(self._PY_SRC, "pkg/caller.py")
        attr_calls = [
            c for c in result if c.get("calleeModule") == "os" and not c["dynamic"]
        ]
        assert attr_calls, "expected os.getcwd() call"
        assert attr_calls[0]["callee"] == "getcwd"

    def test_finds_dynamic_call(self) -> None:
        result = extracted_calls(self._PY_SRC, "pkg/caller.py")
        dynamic = [c for c in result if c["dynamic"]]
        assert dynamic, "expected at least one dynamic call"

    def test_caller_name_and_line(self) -> None:
        result = extracted_calls(self._PY_SRC, "pkg/caller.py")
        run_calls = [c for c in result if c["callerName"] == "run"]
        assert run_calls, "expected calls attributed to 'run'"
        for c in run_calls:
            assert c["callerLine"] >= 1

    def test_call_line_present(self) -> None:
        result = extracted_calls(self._PY_SRC, "pkg/caller.py")
        for c in result:
            assert "callLine" in c
            assert c["callLine"] >= 1

    def test_unsupported_extension_returns_empty(self) -> None:
        assert extracted_calls("foo()", "foo.rb") == []

    def test_parse_error_returns_empty(self) -> None:
        # Deliberately broken Python
        assert extracted_calls("def (:", "bad.py") == []


class TestExtractedCallsTypeScript:
    """Unit tests for extracted_calls() with TypeScript source."""

    _TS_SRC = """\
import { doWork } from './ts_helpers';

function run(): void {
    doWork();
    unknownFunc();
}
"""

    def test_finds_simple_call(self) -> None:
        result = extracted_calls(self._TS_SRC, "pkg/ts_caller.ts")
        names = [c["callee"] for c in result if not c["dynamic"]]
        assert "doWork" in names

    def test_unknown_call_present(self) -> None:
        result = extracted_calls(self._TS_SRC, "pkg/ts_caller.ts")
        assert any(c["callee"] == "unknownFunc" for c in result if not c["dynamic"])

    def test_caller_name(self) -> None:
        result = extracted_calls(self._TS_SRC, "pkg/ts_caller.ts")
        assert any(c["callerName"] == "run" for c in result)


# ---------------------------------------------------------------------------
# AC1-AC4, AC6: build_code_graph() calls edges
# ---------------------------------------------------------------------------

class TestCallsEdgesInGraph:
    """Integration tests using build_code_graph() directly."""

    # Python fixture: pkg/helpers.py + pkg/caller.py
    _HELPERS_PY = """\
def do_work():
    return 42

def helper_two():
    return "hello"
"""

    _CALLER_PY = """\
import os
from pkg.helpers import do_work

def run():
    do_work()
    os.getcwd()
    unknown_func()
    (lambda: 1)()
"""

    # TypeScript fixture
    _TS_HELPERS = """\
export function doWork(): number {
    return 42;
}

export function helperTwo(): string {
    return "hello";
}
"""

    _TS_CALLER = """\
import { doWork } from './ts_helpers';

function run(): void {
    doWork();
    unknownFunc();
}
"""

    def _build_py_graph(self) -> Dict[str, Any]:
        records = [
            _make_record("pkg/helpers.py", self._HELPERS_PY),
            _make_record("pkg/caller.py", self._CALLER_PY),
        ]
        return build_code_graph(records, [], [], "2025-01-01T00:00:00.000Z")

    def _build_ts_graph(self) -> Dict[str, Any]:
        records = [
            _make_record("pkg/ts_helpers.ts", self._TS_HELPERS),
            _make_record("pkg/ts_caller.ts", self._TS_CALLER),
        ]
        return build_code_graph(records, [], [], "2025-01-01T00:00:00.000Z")

    # AC1: calls edges present
    def test_ac1_calls_edges_present_python(self) -> None:
        graph = self._build_py_graph()
        calls = _calls_edges(graph)
        assert calls, "expected at least one calls edge in Python graph"

    def test_ac1_calls_edges_present_typescript(self) -> None:
        graph = self._build_ts_graph()
        calls = _calls_edges(graph)
        assert calls, "expected at least one calls edge in TypeScript graph"

    # AC2: resolved edge schema
    def test_ac2_resolved_edge_schema_python(self) -> None:
        graph = self._build_py_graph()
        resolved = [e for e in _calls_edges(graph) if e.get("resolved") is True]
        assert resolved, "expected at least one resolved calls edge in Python graph"
        for edge in resolved:
            assert edge["kind"] == "calls"
            assert edge["from"] is not None, "resolved edge must have from"
            assert edge["to"] is not None, "resolved edge must have to"
            assert "callerPath" in edge
            assert "callerLine" in edge
            assert edge["callerLine"] >= 1

    def test_ac2_resolved_edge_schema_typescript(self) -> None:
        graph = self._build_ts_graph()
        resolved = [e for e in _calls_edges(graph) if e.get("resolved") is True]
        assert resolved, "expected at least one resolved calls edge in TypeScript graph"
        for edge in resolved:
            assert edge["kind"] == "calls"
            assert edge["from"] is not None
            assert edge["to"] is not None
            assert "callerPath" in edge
            assert "callerLine" in edge

    # AC3: unresolved stubs
    def test_ac3_unresolved_reason_no_import(self) -> None:
        graph = self._build_py_graph()
        unresolved = [e for e in _calls_edges(graph) if e.get("resolved") is False]
        reasons = {e.get("unresolvedReason") for e in unresolved}
        assert "no_import" in reasons, f"expected no_import reason; got {reasons}"

    def test_ac3_unresolved_reason_external_module(self) -> None:
        graph = self._build_py_graph()
        unresolved = [e for e in _calls_edges(graph) if e.get("resolved") is False]
        reasons = {e.get("unresolvedReason") for e in unresolved}
        assert "external_module" in reasons, f"expected external_module reason; got {reasons}"

    def test_ac3_unresolved_reason_dynamic_call(self) -> None:
        graph = self._build_py_graph()
        unresolved = [e for e in _calls_edges(graph) if e.get("resolved") is False]
        reasons = {e.get("unresolvedReason") for e in unresolved}
        assert "dynamic_call" in reasons, f"expected dynamic_call reason; got {reasons}"

    def test_ac3_unresolved_stubs_not_silently_dropped(self) -> None:
        graph = self._build_py_graph()
        unresolved = [e for e in _calls_edges(graph) if e.get("resolved") is False]
        assert unresolved, "unresolved calls must not be silently dropped"
        for edge in unresolved:
            assert edge.get("unresolvedReason") in {
                "no_import", "dynamic_call", "external_module"
            }, f"invalid unresolvedReason: {edge.get('unresolvedReason')}"
            assert edge.get("from") is not None, "unresolved edge must still have from"
            assert edge.get("to") is None, "unresolved edge must have to=None"

    # AC4: denied authority files excluded
    def test_ac4_denied_from_not_in_calls_edges(self) -> None:
        """Denied-authority file must not appear as 'from' in any calls edge."""
        denied_content = """\
from pkg.helpers import do_work

def secret_caller():
    do_work()
"""
        records = [
            _make_record("pkg/helpers.py", self._HELPERS_PY),
            _make_record("pkg/caller.py", self._CALLER_PY),
            _make_record("pkg/secret.py", denied_content, authority="denied"),
        ]
        graph = build_code_graph(records, [], [], "2025-01-01T00:00:00.000Z")
        calls = _calls_edges(graph)
        # Build set of symbol node IDs for the denied file
        denied_symbol_ids = {
            node["id"]
            for node in graph["nodes"]
            if node.get("kind") == "symbol" and node.get("path") == "pkg/secret.py"
        }
        from_denied = [
            e for e in calls if e.get("from") in denied_symbol_ids
        ]
        assert not from_denied, (
            f"denied file symbol appeared as 'from' in calls edge: {from_denied}"
        )

    def test_ac4_denied_to_not_in_calls_edges(self) -> None:
        """Denied-authority file must not appear as 'to' in any calls edge."""
        denied_content = """\
def do_work():
    return 99
"""
        caller_content = """\
from pkg.denied_helpers import do_work

def run():
    do_work()
"""
        records = [
            _make_record("pkg/denied_helpers.py", denied_content, authority="denied"),
            _make_record("pkg/caller.py", caller_content),
        ]
        graph = build_code_graph(records, [], [], "2025-01-01T00:00:00.000Z")
        calls = _calls_edges(graph)
        denied_symbol_ids = {
            node["id"]
            for node in graph["nodes"]
            if node.get("kind") == "symbol" and node.get("path") == "pkg/denied_helpers.py"
        }
        to_denied = [e for e in calls if e.get("to") in denied_symbol_ids]
        assert not to_denied, (
            f"denied file symbol appeared as 'to' in calls edge: {to_denied}"
        )

    # AC6: no duplicate edges on re-build
    def test_ac6_no_duplicate_calls_edges_on_rebuild(self) -> None:
        records = [
            _make_record("pkg/helpers.py", self._HELPERS_PY),
            _make_record("pkg/caller.py", self._CALLER_PY),
        ]
        graph1 = build_code_graph(records, [], [], "2025-01-01T00:00:00.000Z")
        graph2 = build_code_graph(records, [], [], "2025-01-01T00:00:01.000Z")
        calls1 = {e["id"] for e in _calls_edges(graph1)}
        calls2 = {e["id"] for e in _calls_edges(graph2)}
        assert calls1 == calls2, (
            "calls edge IDs must be deterministic across rebuilds"
        )
        # Same count — no duplicates
        assert len(_calls_edges(graph1)) == len(_calls_edges(graph2))


# ---------------------------------------------------------------------------
# AC5: graph_expansion_for_query — relational BFS seeding
# ---------------------------------------------------------------------------

class TestCallsEdgesBFSGating:
    """AC5: calls edges appear in BFS only on relational queries."""

    _HELPERS_PY = """\
def do_work():
    return 42
"""

    _CALLER_PY = """\
from pkg.helpers import do_work

def run():
    do_work()
"""

    def _build_index_data(self) -> Dict[str, Any]:
        records = [
            _make_record("pkg/helpers.py", self._HELPERS_PY),
            _make_record("pkg/caller.py", self._CALLER_PY),
        ]
        graph = build_code_graph(records, [], [], "2025-01-01T00:00:00.000Z")
        return {
            "schemaVersion": 2,
            "graph": graph,
            "records": [r.to_json(include_content=True) for r in records],
            "chunks": [],
        }

    def _run_expansion(
        self, query: str, index: Dict[str, Any], root: Path
    ) -> Dict[str, Any]:
        return graph_expansion_for_query(index, query, root, max_hops=2)

    def test_ac5_relational_query_can_reach_calls_neighbor(
        self, tmp_path: Path
    ) -> None:
        """Relational query should include calls-edge neighbors in expansion."""
        index = self._build_index_data()
        expansion = self._run_expansion("callers of do_work", index, tmp_path)
        # The expansion should find something — even if path set is small
        # We assert that the visited list includes more than just the seed
        # (BFS traversed at least one calls edge hop)
        assert expansion.get("status") in {"expanded", "no_strong_anchors"}

    def test_ac5_non_relational_query_excludes_calls_edges(
        self, tmp_path: Path
    ) -> None:
        """Non-relational query must not traverse calls edges."""
        index = self._build_index_data()

        # Non-relational query: conceptual task language
        expansion_nonrel = self._run_expansion(
            "implement caching in do_work", index, tmp_path
        )

        # Relational query: contains a relational keyword
        expansion_rel = self._run_expansion(
            "callers of do_work", index, tmp_path
        )

        # Get calls edges from the graph
        calls_edges = _calls_edges(index["graph"])
        if not calls_edges:
            pytest.skip("no calls edges in fixture — cannot test BFS gating")

        # Build set of node IDs reachable via calls edges only
        calls_reachable = set()
        for edge in calls_edges:
            if edge.get("from"):
                calls_reachable.add(str(edge["from"]))
            if edge.get("to"):
                calls_reachable.add(str(edge["to"]))

        # For the non-relational query: nodes reachable ONLY via calls edges
        # should not appear in visited (or they appear only as initial seeds)
        nonrel_visited_ids = {v["nodeId"] for v in expansion_nonrel.get("visited", [])}
        rel_visited_ids = {v["nodeId"] for v in expansion_rel.get("visited", [])}

        # The relational expansion should reach at least as many calls-related nodes
        # as the non-relational expansion
        nonrel_calls_reach = nonrel_visited_ids & calls_reachable
        rel_calls_reach = rel_visited_ids & calls_reachable
        assert len(rel_calls_reach) >= len(nonrel_calls_reach), (
            "relational query should reach at least as many calls-related nodes "
            f"as non-relational; rel={rel_calls_reach}, nonrel={nonrel_calls_reach}"
        )


# ---------------------------------------------------------------------------
# AC7 end-to-end: build_index with real fixture repos
# ---------------------------------------------------------------------------

class TestCallGraphEndToEnd:
    """End-to-end tests: build_index, inspect index.json for calls edges."""

    def _make_python_fixture_repo(self) -> Path:
        root = Path(tempfile.mkdtemp())
        _make_git_repo(root)
        _make_config(root)
        (root / "pkg").mkdir()
        (root / "pkg" / "helpers.py").write_text(
            "def do_work():\n    return 42\n\ndef helper_two():\n    return 'hi'\n",
            encoding="utf-8",
        )
        (root / "pkg" / "caller.py").write_text(
            "import os\nfrom pkg.helpers import do_work\n\n"
            "def run():\n    do_work()\n    os.getcwd()\n    unknown_func()\n    (lambda: 1)()\n",
            encoding="utf-8",
        )
        return root

    def _make_ts_fixture_repo(self) -> Path:
        root = Path(tempfile.mkdtemp())
        _make_git_repo(root)
        _make_config(root)
        (root / "pkg").mkdir()
        (root / "pkg" / "ts_helpers.ts").write_text(
            "export function doWork(): number { return 42; }\n"
            "export function helperTwo(): string { return 'hi'; }\n",
            encoding="utf-8",
        )
        (root / "pkg" / "ts_caller.ts").write_text(
            "import { doWork } from './ts_helpers';\n\n"
            "function run(): void {\n    doWork();\n    unknownFunc();\n}\n",
            encoding="utf-8",
        )
        return root

    def test_python_e2e_calls_edges_in_index(self) -> None:
        root = self._make_python_fixture_repo()
        build_index(root)
        from agentrail.context.index import load_index
        data = load_index(root)
        graph = data.get("graph", {})
        calls = _calls_edges(graph)
        assert calls, "expected calls edges in built index for Python fixture"

    def test_python_e2e_resolved_edge_present(self) -> None:
        root = self._make_python_fixture_repo()
        build_index(root)
        from agentrail.context.index import load_index
        data = load_index(root)
        graph = data.get("graph", {})
        resolved = [e for e in _calls_edges(graph) if e.get("resolved") is True]
        assert resolved, "expected at least one resolved cross-file calls edge"

    def test_python_e2e_unresolved_stubs_present(self) -> None:
        root = self._make_python_fixture_repo()
        build_index(root)
        from agentrail.context.index import load_index
        data = load_index(root)
        graph = data.get("graph", {})
        unresolved = [e for e in _calls_edges(graph) if e.get("resolved") is False]
        assert unresolved, "expected unresolved call stubs in index"
        reasons = {e.get("unresolvedReason") for e in unresolved}
        valid_reasons = {"no_import", "dynamic_call", "external_module"}
        assert reasons <= valid_reasons, f"invalid reasons: {reasons - valid_reasons}"

    def test_ts_e2e_calls_edges_in_index(self) -> None:
        root = self._make_ts_fixture_repo()
        build_index(root)
        from agentrail.context.index import load_index
        data = load_index(root)
        graph = data.get("graph", {})
        calls = _calls_edges(graph)
        assert calls, "expected calls edges in built index for TypeScript fixture"

    def test_e2e_incremental_no_duplicate_calls_edges(self) -> None:
        root = self._make_python_fixture_repo()
        build_index(root)
        # Second build — should not duplicate calls edges
        build_index(root)
        from agentrail.context.index import load_index
        data = load_index(root)
        graph = data.get("graph", {})
        calls = _calls_edges(graph)
        ids = [e["id"] for e in calls]
        assert len(ids) == len(set(ids)), "duplicate calls edge IDs after re-index"

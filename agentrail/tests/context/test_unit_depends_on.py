"""Tests for the unit_depends_on rollup + per-unit stats in the code graph.

Repo Wiki spec (docs/superpowers/specs/2026-07-23-repo-wiki-compiled-repo-knowledge-design.md),
delivery plan S7 row 1: "unit_depends_on rollup + per-unit export summary in
index/graph". Acceptance criteria from that row:

AC1: Edges deterministic from imports_file x contains_file (cross-unit resolved
     imports aggregate to ONE unit_depends_on edge per (fromUnit, toUnit) pair,
     with a correct importCount; same-unit pairs and unresolved imports never
     count).
AC2: codebase_unit nodes gain deterministic fileCount/symbolCount/testCount.
AC3: ingestionHealth gains graphUnitDependencyEdgeCount; existing fields
     untouched.
AC4: graph tests extended (this file).
AC5: no retrieval behavior change -- _graph_neighbors, _graph_distance_by_path,
     and graph_expansion_for_query all ignore unit_depends_on edges; results
     are identical with the new edges present vs a graph without them.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict, List

from agentrail.context.index import (
    build_code_graph,
    build_index_snapshot,
    codebase_unit,
    graph_codebase_unit_node_id,
)
from agentrail.context.models import Freshness, SourceRecord
from agentrail.context.retrieval import (
    _graph_distance_by_path,
    _graph_neighbors,
    graph_expansion_for_query,
)
from agentrail.shared.fs import sha256_text


# ---------------------------------------------------------------------------
# Helpers -- mirrors agentrail/tests/context/test_call_graph.py's _make_record
# so build_code_graph can be exercised directly, without a full git+config
# fixture repo.
# ---------------------------------------------------------------------------

def _make_record(path: str, content: str, *, authority: str = "normal") -> SourceRecord:
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


def _unit_depends_on_edges(graph: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [e for e in graph["edges"] if e.get("kind") == "unit_depends_on"]


# Two-unit fixture: pkg_a/{mod1,mod2,mod3,mod4,test_mod1}.py, pkg_b/{helper,other}.py
#
# Cross-unit resolved imports (must roll up):
#   pkg_a/mod1.py -> pkg_b/helper.py   (A->B)
#   pkg_a/mod2.py -> pkg_b/helper.py   (A->B, same pair as above: importCount=2)
#   pkg_b/other.py -> pkg_a/mod1.py    (B->A, the reverse direction, importCount=1)
#
# Must NOT roll up:
#   pkg_a/mod3.py -> pkg_a/mod1.py     (same-unit; a real imports_file edge,
#                                        deliberately excluded from the rollup)
#   pkg_a/mod4.py -> os                (unresolved -- kind=unresolved_import,
#                                        never even considered)
#   pkg_a/test_mod1.py -> pkg_a/mod1.py (same-unit; also exercises testCount)

_MOD1_PY = "from pkg_b.helper import do_work\n\ndef run_mod1():\n    return do_work()\n"
_MOD2_PY = "from pkg_b.helper import do_work\n\ndef run_mod2():\n    return do_work()\n"
_MOD3_PY = "from pkg_a.mod1 import run_mod1\n\ndef run_mod3():\n    return run_mod1()\n"
_MOD4_PY = "import os\n\ndef run_mod4():\n    return os.getcwd()\n"
_TEST_MOD1_PY = "from pkg_a.mod1 import run_mod1\n\ndef test_run_mod1():\n    assert run_mod1() == 42\n"
_HELPER_PY = "def do_work():\n    return 42\n"
_OTHER_PY = "from pkg_a.mod1 import run_mod1\n\ndef call_back():\n    return run_mod1()\n"


def _two_unit_records() -> List[SourceRecord]:
    return [
        _make_record("pkg_a/mod1.py", _MOD1_PY),
        _make_record("pkg_a/mod2.py", _MOD2_PY),
        _make_record("pkg_a/mod3.py", _MOD3_PY),
        _make_record("pkg_a/mod4.py", _MOD4_PY),
        _make_record("pkg_a/test_mod1.py", _TEST_MOD1_PY),
        _make_record("pkg_b/helper.py", _HELPER_PY),
        _make_record("pkg_b/other.py", _OTHER_PY),
    ]


def _two_units() -> List[Dict[str, Any]]:
    return [
        codebase_unit("pkg-a", "pkg_a", "pkg_a", "workspace_manifest", manifest_path="package.json"),
        codebase_unit("pkg-b", "pkg_b", "pkg_b", "workspace_manifest", manifest_path="package.json"),
    ]


UNIT_A, UNIT_B = _two_units()


# ---------------------------------------------------------------------------
# AC1: aggregation correctness
# ---------------------------------------------------------------------------

class UnitDependsOnRollupTests(unittest.TestCase):
    def _build(self) -> Dict[str, Any]:
        return build_code_graph(_two_unit_records(), [], _two_units(), "2025-01-01T00:00:00.000Z")

    def test_cross_unit_imports_aggregate_to_one_edge_with_import_count(self) -> None:
        graph = self._build()
        rollup = _unit_depends_on_edges(graph)
        a_to_b = [e for e in rollup if e["fromUnitId"] == UNIT_A["id"] and e["toUnitId"] == UNIT_B["id"]]
        self.assertEqual(len(a_to_b), 1, f"expected exactly one pkg_a->pkg_b edge, got {a_to_b}")
        edge = a_to_b[0]
        self.assertEqual(edge["importCount"], 2, "mod1.py and mod2.py both import pkg_b.helper")
        self.assertEqual(edge["kind"], "unit_depends_on")
        self.assertIs(edge["deterministic"], True)
        self.assertEqual(edge["authority"], "deterministic")
        self.assertEqual(edge["from"], graph_codebase_unit_node_id(UNIT_A["id"]))
        self.assertEqual(edge["to"], graph_codebase_unit_node_id(UNIT_B["id"]))

    def test_reverse_direction_is_a_distinct_edge(self) -> None:
        graph = self._build()
        rollup = _unit_depends_on_edges(graph)
        b_to_a = [e for e in rollup if e["fromUnitId"] == UNIT_B["id"] and e["toUnitId"] == UNIT_A["id"]]
        self.assertEqual(len(b_to_a), 1, f"expected exactly one pkg_b->pkg_a edge, got {b_to_a}")
        self.assertEqual(b_to_a[0]["importCount"], 1, "only pkg_b/other.py imports pkg_a.mod1")

    def test_same_unit_import_produces_no_rollup_edge(self) -> None:
        graph = self._build()
        rollup = _unit_depends_on_edges(graph)
        same_unit = [e for e in rollup if e["fromUnitId"] == e["toUnitId"]]
        self.assertEqual(same_unit, [], "same-unit import (mod3 -> mod1) must not roll up")

    def test_unresolved_import_is_never_counted(self) -> None:
        graph = self._build()
        rollup = _unit_depends_on_edges(graph)
        total_import_count = sum(e["importCount"] for e in rollup)
        # 3 resolved cross-unit imports total (mod1->helper, mod2->helper,
        # other->mod1); mod4's `import os` is unresolved and must not inflate
        # any count, and same-unit imports (mod3->mod1, test_mod1->mod1) must
        # not appear at all.
        self.assertEqual(total_import_count, 3)

    def test_exactly_two_rollup_edges_total(self) -> None:
        graph = self._build()
        rollup = _unit_depends_on_edges(graph)
        pairs = sorted((e["fromUnitId"], e["toUnitId"]) for e in rollup)
        self.assertEqual(pairs, sorted([(UNIT_A["id"], UNIT_B["id"]), (UNIT_B["id"], UNIT_A["id"])]))

    def test_single_unit_graph_has_no_rollup_edges(self) -> None:
        records = [_make_record("app.py", "def main():\n    pass\n")]
        units = [codebase_unit("root", "root", ".", "fallback")]
        graph = build_code_graph(records, [], units, "2025-01-01T00:00:00.000Z")
        self.assertEqual(_unit_depends_on_edges(graph), [])

    def test_no_codebase_units_has_no_rollup_edges(self) -> None:
        records = [_make_record("app.py", "def main():\n    pass\n")]
        graph = build_code_graph(records, [], [], "2025-01-01T00:00:00.000Z")
        self.assertEqual(_unit_depends_on_edges(graph), [])

    def test_enrichment_stub_untouched(self) -> None:
        """The rollup is deterministic aggregation, never Graph Enrichment."""
        graph = self._build()
        self.assertEqual(graph["enrichment"], {"status": "not_used", "authority": "none", "llmGeneratedAuthoritative": False})


# ---------------------------------------------------------------------------
# AC2: per-unit node stats
# ---------------------------------------------------------------------------

class UnitNodeStatsTests(unittest.TestCase):
    def test_unit_nodes_carry_deterministic_file_symbol_test_counts(self) -> None:
        graph = build_code_graph(_two_unit_records(), [], _two_units(), "2025-01-01T00:00:00.000Z")
        unit_nodes = {n["unitId"]: n for n in graph["nodes"] if n["kind"] == "codebase_unit"}
        pkg_a = unit_nodes[UNIT_A["id"]]
        pkg_b = unit_nodes[UNIT_B["id"]]
        self.assertEqual(pkg_a["fileCount"], 5, "mod1-4.py + test_mod1.py")
        self.assertEqual(pkg_a["symbolCount"], 5, "one function symbol per file")
        self.assertEqual(pkg_a["testCount"], 1, "test_mod1.py only")
        self.assertEqual(pkg_b["fileCount"], 2, "helper.py + other.py")
        self.assertEqual(pkg_b["symbolCount"], 2)
        self.assertEqual(pkg_b["testCount"], 0)

    def test_stats_present_for_trivial_single_unit_repo(self) -> None:
        records = [_make_record("app.py", "def main():\n    pass\n")]
        units = [codebase_unit("root", "root", ".", "fallback")]
        graph = build_code_graph(records, [], units, "2025-01-01T00:00:00.000Z")
        unit_node = next(n for n in graph["nodes"] if n["kind"] == "codebase_unit")
        self.assertEqual(unit_node["fileCount"], 1)
        self.assertEqual(unit_node["symbolCount"], 1)
        self.assertEqual(unit_node["testCount"], 0)


# ---------------------------------------------------------------------------
# AC3: ingestionHealth
# ---------------------------------------------------------------------------

class IngestionHealthUnitDependencyCountTests(unittest.TestCase):
    def test_graph_unit_dependency_edge_count_matches_rollup_edges(self) -> None:
        root = Path(tempfile.mkdtemp())
        records = _two_unit_records()
        graph = build_code_graph(records, [], _two_units(), "2025-01-01T00:00:00.000Z")
        snapshot = build_index_snapshot(root, records, graph, "2025-01-01T00:00:00.000Z", 0, 0)
        health = snapshot["ingestionHealth"]
        self.assertEqual(health["graphUnitDependencyEdgeCount"], 2)
        # Existing fields untouched (AC3's other half).
        self.assertEqual(health["status"], "healthy")
        self.assertEqual(health["indexedCount"], len(records))
        self.assertEqual(health["skippedCount"], 0)
        self.assertEqual(health["redactionCount"], 0)
        self.assertEqual(health["graphNodeCount"], len(graph["nodes"]))
        self.assertEqual(health["graphEdgeCount"], len(graph["edges"]))
        self.assertIn("parserVersions", health)

    def test_zero_when_no_cross_unit_dependencies(self) -> None:
        root = Path(tempfile.mkdtemp())
        records = [_make_record("app.py", "def main():\n    pass\n")]
        units = [codebase_unit("root", "root", ".", "fallback")]
        graph = build_code_graph(records, [], units, "2025-01-01T00:00:00.000Z")
        snapshot = build_index_snapshot(root, records, graph, "2025-01-01T00:00:00.000Z", 0, 0)
        self.assertEqual(snapshot["ingestionHealth"]["graphUnitDependencyEdgeCount"], 0)


# ---------------------------------------------------------------------------
# Determinism (mirrors test_call_graph.py's AC6 "no duplicate calls edges on
# rebuild" pattern for the new edge kind).
# ---------------------------------------------------------------------------

class UnitDependsOnDeterminismTests(unittest.TestCase):
    def test_rebuild_produces_identical_rollup_edges(self) -> None:
        records = _two_unit_records()
        units = _two_units()
        graph1 = build_code_graph(records, [], units, "2025-01-01T00:00:00.000Z")
        graph2 = build_code_graph(records, [], units, "2025-01-01T00:00:01.000Z")
        self.assertEqual(_unit_depends_on_edges(graph1), _unit_depends_on_edges(graph2))

    def test_rollup_is_independent_of_record_input_order(self) -> None:
        records = _two_unit_records()
        units = _two_units()
        graph_forward = build_code_graph(records, [], units, "2025-01-01T00:00:00.000Z")
        graph_reversed = build_code_graph(list(reversed(records)), [], units, "2025-01-01T00:00:00.000Z")
        self.assertEqual(_unit_depends_on_edges(graph_forward), _unit_depends_on_edges(graph_reversed))


# ---------------------------------------------------------------------------
# AC5 / CRITICAL: no retrieval behavior change. graph_expansion_for_query,
# _graph_distance_by_path, and _graph_neighbors must all behave exactly as if
# unit_depends_on edges did not exist.
# ---------------------------------------------------------------------------

class QueryTimeTraversalExclusionTests(unittest.TestCase):
    def _graphs_with_and_without_rollup(self) -> tuple[Dict[str, Any], Dict[str, Any]]:
        records = _two_unit_records()
        units = _two_units()
        graph_with = build_code_graph(records, [], units, "2025-01-01T00:00:00.000Z")
        rollup = _unit_depends_on_edges(graph_with)
        self.assertTrue(rollup, "fixture must actually produce unit_depends_on edges for this to be a real regression test")
        graph_without = {**graph_with, "edges": [e for e in graph_with["edges"] if e.get("kind") != "unit_depends_on"]}
        return graph_with, graph_without

    def _index_for(self, graph: Dict[str, Any], records: List[SourceRecord]) -> Dict[str, Any]:
        return {
            "schemaVersion": 2,
            "graph": graph,
            "records": [r.to_json(include_content=True) for r in records],
            "chunks": [],
            "symbolTable": {},
        }

    def test_graph_neighbors_never_surfaces_unit_depends_on(self) -> None:
        graph_with, _ = self._graphs_with_and_without_rollup()
        neighbors = _graph_neighbors(graph_with)
        for node_id, edge_list in neighbors.items():
            for edge in edge_list:
                self.assertNotEqual(edge.get("kind"), "unit_depends_on", f"unit_depends_on leaked into _graph_neighbors adjacency for {node_id}")

    def test_graph_distance_by_path_identical_with_and_without_rollup(self) -> None:
        """Seeded from pkg_a/mod3.py (same-unit import only, no direct
        cross-unit edge of its own): pkg_b's UNIT node is reachable at hop 2
        ONLY via the rollup edge (mod3 -> unit_a (1) -> unit_b (2)); the
        legitimate route is 3 hops (mod3 -> mod1 (1) -> helper.py (2) ->
        unit_b (3)). This is the scenario that would actually go wrong if
        the exclusion regressed -- a shorter, illegitimate path via the
        rollup edge changing which paths/depths retrieval sees.
        """
        graph_with, graph_without = self._graphs_with_and_without_rollup()
        anchors = [{"kind": "path", "value": "pkg_a/mod3.py", "normalized": "pkg_a/mod3.py"}]
        distance_with = _graph_distance_by_path({"graph": graph_with}, anchors, max_hops=2)
        distance_without = _graph_distance_by_path({"graph": graph_without}, anchors, max_hops=2)
        self.assertEqual(distance_with, distance_without)
        # And, concretely: the unit's own bare path never appears at hop 2.
        self.assertNotIn(UNIT_B["path"], distance_with)

    def test_graph_expansion_for_query_identical_non_relational(self) -> None:
        records = _two_unit_records()
        graph_with, graph_without = self._graphs_with_and_without_rollup()
        root = Path(tempfile.mkdtemp())
        index_with = self._index_for(graph_with, records)
        index_without = self._index_for(graph_without, records)
        expansion_with = graph_expansion_for_query(index_with, "pkg_a/mod3.py", root, max_hops=2)
        expansion_without = graph_expansion_for_query(index_without, "pkg_a/mod3.py", root, max_hops=2)
        self.assertEqual(expansion_with, expansion_without)
        self.assertNotIn(UNIT_B["path"], expansion_with["paths"])

    def test_graph_expansion_for_query_identical_relational(self) -> None:
        """The word "depends" is a relational keyword (gates `calls` edges
        into BFS). unit_depends_on must stay excluded regardless -- it is not
        gated by query content the way `calls` is; it is never traversed.
        """
        records = _two_unit_records()
        graph_with, graph_without = self._graphs_with_and_without_rollup()
        root = Path(tempfile.mkdtemp())
        index_with = self._index_for(graph_with, records)
        index_without = self._index_for(graph_without, records)
        query = "what depends on pkg_a/mod3.py"
        expansion_with = graph_expansion_for_query(index_with, query, root, max_hops=2)
        expansion_without = graph_expansion_for_query(index_without, query, root, max_hops=2)
        self.assertEqual(expansion_with, expansion_without)
        self.assertNotIn(UNIT_B["path"], expansion_with["paths"])


if __name__ == "__main__":
    unittest.main()

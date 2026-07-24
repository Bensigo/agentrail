"""Tests for the Repo Wiki compiler (agentrail/context/wiki.py).

Repo Wiki spec (docs/superpowers/specs/2026-07-23-repo-wiki-compiled-repo-knowledge-design.md),
delivery plan S7 row 2. Acceptance criteria exercised here:

  AC1 - summary.mode honored; the old "not implemented" raise is retired and
        never fires again for a configured, non-"disabled" mode.
  AC2 - fail-open: any prose-provider error ships a skeleton-only page, never
        a hard failure.
  AC3 - a cost event is emitted (compile-report.json's costUsd).
  AC4 - hash-unchanged pages are byte-identical (and mtime-identical) across
        rebuilds -- no silent rewrite.
  Plus: flag-OFF byte-identical guarantee, cap-24 with logged drops, citation
  post-validation, wiki_doc SourceRecords/chunks present-when-enabled /
  absent-when-disabled, and the `agentrail context wiki build|status|show`
  CLI happy paths.

No test here touches a real LLM: every non-"disabled" summary.mode in this
file uses "custom-command" pointed at a small local Python mock script (the
SAME test seam ``embeddings.py``'s ``run_custom_command`` already
established, see test_embedding_setup.py's MOCK_OK/MOCK_FAIL). "claude-cli"
mode's OWN code path (argv, fail-open on a missing binary) is exercised via
``shutil.which`` monkeypatching, never a real subprocess call.
"""
from __future__ import annotations

import io
import json
import os
import shlex
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import ExitStack, contextmanager, redirect_stdout
from pathlib import Path
from typing import Any, Dict, List, Optional
from unittest import mock

from agentrail.cli.commands.context import run_context
from agentrail.context import wiki
from agentrail.context.index import build_index, load_index

_REPO_WIKI_FLAG = wiki.REPO_WIKI_ENV
_MAX_COST_ENV = wiki.WIKI_MAX_COST_ENV


# ---------------------------------------------------------------------------
# Env helpers (mirrors test_llm_rerank.py's _env / _envs contextmanagers)
# ---------------------------------------------------------------------------


@contextmanager
def _env(key: str, value: Optional[str]):
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


@contextmanager
def _envs(**pairs: Optional[str]):
    with ExitStack() as stack:
        for key, value in pairs.items():
            stack.enter_context(_env(key, value))
        yield


@contextmanager
def _wiki_on(**extra: Optional[str]):
    """Turn the rollout flag ON for the duration of the block, plus any extra
    env vars (e.g. AGENTRAIL_WIKI_MAX_COST_USD)."""
    with _envs(**{_REPO_WIKI_FLAG: "1", **extra}):
        yield


# ---------------------------------------------------------------------------
# Mock prose provider (custom-command mode; see module docstring)
# ---------------------------------------------------------------------------

_MOCK_SCRIPT = """
import json, os, sys

def main():
    raw = sys.stdin.readline()
    try:
        payload = json.loads(raw)
    except Exception:
        payload = {}
    plan_raw = os.environ.get("WIKI_MOCK_PLAN")
    counter_path = os.environ.get("WIKI_MOCK_COUNTER")
    if not plan_raw or not counter_path:
        print(json.dumps({"text": json.dumps({
            "responsibility": "Mock responsibility.",
            "fileNotes": {},
            "relationships": "Mock relationships.",
        }), "usage": {"inputTokens": 100, "outputTokens": 50}}))
        return
    plan = json.loads(plan_raw)
    try:
        with open(counter_path) as fh:
            n = int((fh.read() or "0").strip() or "0")
    except FileNotFoundError:
        n = 0
    with open(counter_path, "w") as fh:
        fh.write(str(n + 1))
    step = plan[min(n, len(plan) - 1)] if plan else {}
    if step.get("status") == "fail":
        sys.stderr.write(step.get("message", "mock failure") + "\\n")
        sys.exit(int(step.get("exitCode", 1)))
    text = step.get("text")
    if text is None:
        text = json.dumps({
            "responsibility": step.get("responsibility", "Mock responsibility."),
            "fileNotes": step.get("fileNotes", {}),
            "relationships": step.get("relationships", "Mock relationships."),
        })
    print(json.dumps({"text": text, "usage": step.get("usage", {"inputTokens": 100, "outputTokens": 50})}))

main()
"""


def _write_mock(tmp_dir: Path) -> str:
    script_path = tmp_dir / "mock_prose.py"
    script_path.write_text(_MOCK_SCRIPT, encoding="utf-8")
    return f"{shlex.quote(sys.executable)} {shlex.quote(str(script_path))}"


def _plan_env(tmp_dir: Path, plan: List[Dict[str, Any]]) -> Dict[str, str]:
    counter_path = tmp_dir / "mock_counter.txt"
    if counter_path.exists():
        counter_path.unlink()
    return {"WIKI_MOCK_PLAN": json.dumps(plan), "WIKI_MOCK_COUNTER": str(counter_path)}


# ---------------------------------------------------------------------------
# Repo fixture
# ---------------------------------------------------------------------------

_TWO_UNIT_FILES = {
    "pkg_a/mod1.py": "from pkg_b.helper import do_work\n\n\ndef run_mod1():\n    return do_work()\n",
    "pkg_b/helper.py": "def do_work():\n    return 42\n",
}

_TWO_UNITS = [
    {"id": "pkg-a", "name": "pkg_a", "path": "pkg_a"},
    {"id": "pkg-b", "name": "pkg_b", "path": "pkg_b"},
]


def make_repo(
    *,
    codebase_units: Optional[List[Dict[str, Any]]] = None,
    summary_mode: str = "disabled",
    summary_command: Optional[str] = None,
    files: Optional[Dict[str, str]] = None,
) -> Path:
    """A small temp git repo (with an initial commit, so commitSha is real)
    with a configurable ``context.summary`` provider and an explicit
    ``codebaseUnits`` override (avoids relying on manifest/workspace
    detection heuristics -- mirrors test_unit_depends_on.py's approach of
    pinning units precisely)."""
    root = Path(tempfile.mkdtemp())
    subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.email", "test@example.com"], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.name", "Test"], check=True)
    (root / ".agentrail").mkdir()

    summary_cfg: Dict[str, Any] = {"mode": summary_mode}
    if summary_command is not None:
        summary_cfg.update({"provider": "mock", "model": "mock-model", "customCommand": summary_command})

    ctx = {
        "includeGlobs": ["**/*"],
        "excludeGlobs": [".git/**", ".agentrail/context/**"],
        "maxFileSizeBytes": 262144,
        "skipBinary": True,
        "respectGitIgnore": True,
        "secretRedaction": {"enabled": False, "action": "exclude", "denyGlobs": []},
        "embedding": {"mode": "disabled", "provider": None, "model": None},
        "summary": summary_cfg,
        "codebaseUnits": codebase_units if codebase_units is not None else list(_TWO_UNITS),
    }
    (root / ".agentrail" / "config.json").write_text(json.dumps({"schemaVersion": 1, "context": ctx}, indent=2), encoding="utf-8")

    for rel_path, content in (files if files is not None else _TWO_UNIT_FILES).items():
        full_path = root / rel_path
        full_path.parent.mkdir(parents=True, exist_ok=True)
        full_path.write_text(content, encoding="utf-8")

    subprocess.run(["git", "-C", str(root), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(root), "commit", "-m", "init", "--quiet"], check=True)
    return root


def _wiki_records(index_data: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [record for record in index_data.get("records", []) if record.get("sourceType") == "wiki_doc"]


# ---------------------------------------------------------------------------
# AC: flag-OFF byte-identical guarantee
# ---------------------------------------------------------------------------


class FlagOffByteIdenticalTests(unittest.TestCase):
    def test_defaults_produce_no_wiki_artifacts(self) -> None:
        """Flag unset AND summary.mode "disabled" (both defaults): no
        .agentrail/context/wiki/ dir, no wiki_doc records, no wikiReport key."""
        root = make_repo(summary_mode="disabled")
        with _env(_REPO_WIKI_FLAG, None):
            result = build_index(root)
        self.assertNotIn("wikiReport", result)
        self.assertFalse(wiki.wiki_dir_for(root).exists())
        index_data = load_index(root)
        self.assertEqual(_wiki_records(index_data), [])

    def test_mode_configured_but_flag_unset_still_skips(self) -> None:
        """summary.mode != "disabled" alone is not enough -- the rollout flag
        must ALSO be set (spec S4.2's "AND" gate)."""
        mock_dir = Path(tempfile.mkdtemp())
        command = _write_mock(mock_dir)
        root = make_repo(summary_mode="custom-command", summary_command=command)
        with _env(_REPO_WIKI_FLAG, None):
            result = build_index(root)
        self.assertNotIn("wikiReport", result)
        self.assertFalse(wiki.wiki_dir_for(root).exists())

    def test_flag_set_but_mode_disabled_still_skips(self) -> None:
        root = make_repo(summary_mode="disabled")
        with _wiki_on():
            result = build_index(root)
        self.assertNotIn("wikiReport", result)
        self.assertFalse(wiki.wiki_dir_for(root).exists())

    def test_second_build_still_cache_hits_when_flag_off(self) -> None:
        """The wiki_enabled gate added to the content-based-cache shortcut
        must not perturb the pre-existing cache-hit behavior when OFF."""
        root = make_repo(summary_mode="disabled")
        with _env(_REPO_WIKI_FLAG, None):
            r1 = build_index(root)
            self.assertIs(r1["cacheHit"], False)
            r2 = build_index(root)
            self.assertIs(r2["cacheHit"], True)
            self.assertEqual(r2["rebuiltSources"], 0)

    def test_unsupported_mode_string_falls_open_to_skeleton_only(self) -> None:
        """A garbage/unsupported (but non-"disabled") mode string used to hit
        the SAME unconditional "not implemented" raise as any other
        non-"disabled" value. It must now just ship skeleton-only pages,
        never crash -- fail-open covers config typos too, not only real
        provider errors."""
        root = make_repo(summary_mode="some-bogus-mode")
        with _wiki_on():
            result = build_index(root)
        report = result["wikiReport"]
        self.assertEqual(report["llmCalls"], 0)
        self.assertEqual(report["pagesWritten"], 3)
        overview_text = (wiki.wiki_dir_for(root) / "overview.md").read_text(encoding="utf-8")
        self.assertIn("skeleton-only", overview_text)

    def test_not_implemented_raise_is_retired(self) -> None:
        """A configured, non-"disabled" summary.mode with the flag OFF used
        to raise RuntimeError("... is not implemented"); it must now be a
        silent, successful skip."""
        mock_dir = Path(tempfile.mkdtemp())
        command = _write_mock(mock_dir)
        root = make_repo(summary_mode="custom-command", summary_command=command)
        with _env(_REPO_WIKI_FLAG, None):
            try:
                build_index(root)
            except RuntimeError as exc:
                self.fail(f"build_index raised (the retired not-implemented path?): {exc}")

    def test_audit_log_records_skipped_not_not_implemented(self) -> None:
        mock_dir = Path(tempfile.mkdtemp())
        command = _write_mock(mock_dir)
        root = make_repo(summary_mode="custom-command", summary_command=command)
        with _env(_REPO_WIKI_FLAG, None):
            build_index(root)
        audit_path = root / ".agentrail" / "context" / "audit" / "events.jsonl"
        events = [json.loads(line) for line in audit_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        summary_events = [event for event in events if event.get("event") == "contextual_summary"]
        self.assertTrue(summary_events)
        self.assertEqual(summary_events[-1]["action"], "skipped")
        self.assertNotEqual(summary_events[-1]["action"], "not_implemented")


# ---------------------------------------------------------------------------
# AC4: skeleton determinism + hash-unchanged reuse
# ---------------------------------------------------------------------------


class SkeletonDeterminismTests(unittest.TestCase):
    def test_two_builds_produce_byte_identical_pages(self) -> None:
        mock_dir = Path(tempfile.mkdtemp())
        command = _write_mock(mock_dir)
        root = make_repo(summary_mode="custom-command", summary_command=command)
        with _wiki_on():
            build_index(root)
            wiki_dir = wiki.wiki_dir_for(root)
            texts_1 = {p.name: p.read_text(encoding="utf-8") for p in wiki_dir.glob("*.md")}
            mtimes_1 = {p.name: p.stat().st_mtime_ns for p in wiki_dir.glob("*.md")}

            time.sleep(0.05)  # ensure a naive "did it get rewritten" check would see a new mtime
            r2 = build_index(root)
            texts_2 = {p.name: p.read_text(encoding="utf-8") for p in wiki_dir.glob("*.md")}
            mtimes_2 = {p.name: p.stat().st_mtime_ns for p in wiki_dir.glob("*.md")}

        self.assertEqual(texts_1, texts_2, "page bytes must be identical across rebuilds when nothing changed")
        self.assertEqual(mtimes_1, mtimes_2, "unchanged pages must not be rewritten (mtime must not move)")
        self.assertEqual(r2["wikiReport"]["pagesWritten"], 0)
        self.assertEqual(r2["wikiReport"]["pagesReused"], 3)  # overview + pkg-a + pkg-b
        self.assertEqual(r2["wikiReport"]["llmCalls"], 0, "reused pages must incur zero prose calls")
        self.assertEqual(r2["wikiReport"]["costUsd"], 0.0)

    def test_manifest_lists_every_page_with_stale_false(self) -> None:
        mock_dir = Path(tempfile.mkdtemp())
        command = _write_mock(mock_dir)
        root = make_repo(summary_mode="custom-command", summary_command=command)
        with _wiki_on():
            build_index(root)
        manifest = json.loads((wiki.wiki_dir_for(root) / "manifest.json").read_text(encoding="utf-8"))
        slugs = {page["slug"] for page in manifest["pages"]}
        self.assertEqual(slugs, {"wiki/overview", "wiki/unit/pkg-a", "wiki/unit/pkg-b"})
        self.assertTrue(all(page["stale"] is False for page in manifest["pages"]))
        self.assertEqual(manifest["commitSha"], (load_index(root)["snapshot"]["commitSha"]))


# ---------------------------------------------------------------------------
# Incremental: only the changed unit + overview regenerate
# ---------------------------------------------------------------------------


class IncrementalRegenerationTests(unittest.TestCase):
    def test_changed_unit_only_regenerates_that_page_and_overview(self) -> None:
        mock_dir = Path(tempfile.mkdtemp())
        command = _write_mock(mock_dir)
        root = make_repo(summary_mode="custom-command", summary_command=command)
        with _wiki_on():
            build_index(root)
            wiki_dir = wiki.wiki_dir_for(root)
            pkg_a_before = (wiki_dir / "unit__pkg-a.md").read_text(encoding="utf-8")
            pkg_a_mtime_before = (wiki_dir / "unit__pkg-a.md").stat().st_mtime_ns
            pkg_b_before = (wiki_dir / "unit__pkg-b.md").read_text(encoding="utf-8")
            pkg_b_mtime_before = (wiki_dir / "unit__pkg-b.md").stat().st_mtime_ns
            overview_before = (wiki_dir / "overview.md").read_text(encoding="utf-8")

            time.sleep(0.05)
            (root / "pkg_b" / "helper.py").write_text("def do_work():\n    return 43  # changed\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(root), "add", "-A"], check=True)
            subprocess.run(["git", "-C", str(root), "commit", "-m", "change pkg_b", "--quiet"], check=True)

            report = build_index(root)["wikiReport"]

            pkg_a_after = (wiki_dir / "unit__pkg-a.md").read_text(encoding="utf-8")
            pkg_a_mtime_after = (wiki_dir / "unit__pkg-a.md").stat().st_mtime_ns
            pkg_b_after = (wiki_dir / "unit__pkg-b.md").read_text(encoding="utf-8")
            pkg_b_mtime_after = (wiki_dir / "unit__pkg-b.md").stat().st_mtime_ns
            overview_after = (wiki_dir / "overview.md").read_text(encoding="utf-8")

        self.assertEqual(pkg_a_before, pkg_a_after, "unrelated unit's page must not change")
        self.assertEqual(pkg_a_mtime_before, pkg_a_mtime_after, "unrelated unit's page must not be rewritten")
        self.assertNotEqual(pkg_b_before, pkg_b_after, "the changed unit's page must regenerate")
        self.assertNotEqual(pkg_b_mtime_before, pkg_b_mtime_after)
        self.assertNotEqual(overview_before, overview_after, "overview must regenerate when any unit page changed")
        self.assertEqual(report["pagesWritten"], 2, "only pkg-b + overview regenerate")
        self.assertEqual(report["pagesReused"], 1, "pkg-a is reused")


# ---------------------------------------------------------------------------
# AC2: fail-open on provider error
# ---------------------------------------------------------------------------


class FailOpenTests(unittest.TestCase):
    def test_custom_command_failure_ships_skeleton_only_page(self) -> None:
        mock_dir = Path(tempfile.mkdtemp())
        command = _write_mock(mock_dir)
        root = make_repo(summary_mode="custom-command", summary_command=command)
        plan = [{"status": "fail"}] * 3
        with _wiki_on(**_plan_env(mock_dir, plan)):
            result = build_index(root)
        report = result["wikiReport"]
        self.assertEqual(report["pagesWritten"], 3)
        self.assertEqual(report["providerErrors"], 3)
        overview_text = (wiki.wiki_dir_for(root) / "overview.md").read_text(encoding="utf-8")
        self.assertIn("skeleton-only", overview_text)
        self.assertIn('model: "skeleton-only"', overview_text)
        # Deterministic sections are still fully present even though prose failed.
        self.assertIn("## Structure", overview_text)
        self.assertIn("## Key files", overview_text)

    def test_malformed_json_response_counts_as_provider_error(self) -> None:
        """A call that SUCCEEDS (exit 0) but returns unparseable content is
        still a provider error for report visibility, and still falls open."""
        mock_dir = Path(tempfile.mkdtemp())
        command = _write_mock(mock_dir)
        root = make_repo(summary_mode="custom-command", summary_command=command)
        plan = [{"text": "not json at all, just prose"}] * 3
        with _wiki_on(**_plan_env(mock_dir, plan)):
            result = build_index(root)
        report = result["wikiReport"]
        self.assertEqual(report["providerErrors"], 3)
        self.assertEqual(report["llmCalls"], 3, "the calls themselves succeeded and were priced")
        self.assertGreater(report["costUsd"], 0.0, "a malformed response still cost real tokens")
        overview_text = (wiki.wiki_dir_for(root) / "overview.md").read_text(encoding="utf-8")
        self.assertIn("skeleton-only", overview_text)

    def test_build_index_never_raises_on_provider_failure(self) -> None:
        mock_dir = Path(tempfile.mkdtemp())
        command = _write_mock(mock_dir)
        root = make_repo(summary_mode="custom-command", summary_command=command)
        with _wiki_on(**_plan_env(mock_dir, [{"status": "fail"}] * 3)):
            try:
                build_index(root)
            except Exception as exc:  # noqa: BLE001
                self.fail(f"build_index must never raise on a provider failure: {exc}")

    def test_claude_cli_mode_falls_open_when_binary_missing(self) -> None:
        root = make_repo(summary_mode="claude-cli")
        with _wiki_on(), mock.patch("agentrail.context.wiki.shutil.which", return_value=None):
            result = build_index(root)
        report = result["wikiReport"]
        self.assertEqual(report["llmCalls"], 0)
        self.assertEqual(report["costUsd"], 0.0)
        overview_text = (wiki.wiki_dir_for(root) / "overview.md").read_text(encoding="utf-8")
        self.assertIn("skeleton-only", overview_text)

    def test_claude_cli_never_shells_out_in_this_test_suite(self) -> None:
        """Guard against accidentally invoking a real `claude -p` subprocess:
        _call_claude_cli is monkeypatched, never allowed to run for real."""
        root = make_repo(summary_mode="claude-cli")
        with _wiki_on(), mock.patch("agentrail.context.wiki._call_claude_cli") as fake_call:
            fake_call.return_value = (
                json.dumps({"responsibility": "x", "fileNotes": {}, "relationships": "y"}),
                {"inputTokens": 10, "outputTokens": 5},
            )
            result = build_index(root)
        self.assertTrue(fake_call.called)
        self.assertGreater(result["wikiReport"]["llmCalls"], 0)


# ---------------------------------------------------------------------------
# Cost ceiling
# ---------------------------------------------------------------------------


class CostCeilingTests(unittest.TestCase):
    def test_ceiling_stops_further_prose_generation(self) -> None:
        mock_dir = Path(tempfile.mkdtemp())
        command = _write_mock(mock_dir)
        root = make_repo(summary_mode="custom-command", summary_command=command)
        # Every call costs the same (fixed usage); with 3 pages to generate
        # (pkg-a, pkg-b, overview -- pkg-a first per compile_wiki's fileCount/
        # id ordering) set the ceiling so exactly the FIRST call is allowed to
        # complete (crossing the ceiling) and the rest are skipped.
        plan = [{"usage": {"inputTokens": 100000, "outputTokens": 100000}}]
        with _wiki_on(**_plan_env(mock_dir, plan), **{_MAX_COST_ENV: "0.01"}):
            result = build_index(root)
        report = result["wikiReport"]
        self.assertTrue(report["costCeilingExceeded"])
        self.assertEqual(report["llmCalls"], 1, "only the call that crosses the ceiling should run")
        self.assertGreater(report["costUsd"], 0.0)
        # The pages that never got a prose call still shipped, skeleton-only.
        self.assertEqual(report["pagesWritten"], 3)

    def test_default_ceiling_is_half_a_dollar(self) -> None:
        with _env(_MAX_COST_ENV, None):
            self.assertEqual(wiki.wiki_max_cost_usd(), 0.50)

    def test_ceiling_env_override(self) -> None:
        with _env(_MAX_COST_ENV, "2.5"):
            self.assertEqual(wiki.wiki_max_cost_usd(), 2.5)

    def test_invalid_ceiling_env_falls_back_to_default(self) -> None:
        with _env(_MAX_COST_ENV, "not-a-number"):
            self.assertEqual(wiki.wiki_max_cost_usd(), 0.50)


# ---------------------------------------------------------------------------
# Cap at 24 unit pages, drops logged (never silent)
# ---------------------------------------------------------------------------


class CapTests(unittest.TestCase):
    def test_more_than_24_units_caps_and_logs_drops(self) -> None:
        unit_count = 27
        units = [{"id": f"u{i:02d}", "name": f"u{i:02d}", "path": f"u{i:02d}"} for i in range(unit_count)]
        files = {f"u{i:02d}/f.py": f"def f_{i}():\n    return {i}\n" for i in range(unit_count)}
        mock_dir = Path(tempfile.mkdtemp())
        command = _write_mock(mock_dir)
        root = make_repo(codebase_units=units, summary_mode="custom-command", summary_command=command, files=files)
        with _wiki_on():
            result = build_index(root)
        report = result["wikiReport"]
        self.assertEqual(report["unitsTotal"], unit_count)
        self.assertEqual(report["unitsIncluded"], wiki.MAX_UNIT_PAGES)
        self.assertEqual(len(report["unitsDropped"]), unit_count - wiki.MAX_UNIT_PAGES)
        wiki_dir = wiki.wiki_dir_for(root)
        unit_page_count = len(list(wiki_dir.glob("unit__*.md")))
        self.assertEqual(unit_page_count, wiki.MAX_UNIT_PAGES, "never silently write more than the cap")

        audit_path = root / ".agentrail" / "context" / "audit" / "events.jsonl"
        events = [json.loads(line) for line in audit_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        cap_events = [event for event in events if event.get("event") == "wiki_compile" and event.get("action") == "unit_pages_capped"]
        self.assertTrue(cap_events, "the cap must be logged, never silent")
        self.assertEqual(len(cap_events[0]["dropped"]), unit_count - wiki.MAX_UNIT_PAGES)

        overview_text = (wiki_dir / "overview.md").read_text(encoding="utf-8")
        self.assertIn("more unit(s) not shown", overview_text, "the drop must be visible on the overview page itself")


# ---------------------------------------------------------------------------
# wiki_doc SourceRecords / chunks present-when-enabled, absent-when-disabled
# ---------------------------------------------------------------------------


class WikiDocRecordsTests(unittest.TestCase):
    def test_wiki_doc_records_and_chunks_present_when_enabled(self) -> None:
        mock_dir = Path(tempfile.mkdtemp())
        command = _write_mock(mock_dir)
        root = make_repo(summary_mode="custom-command", summary_command=command)
        with _wiki_on():
            build_index(root)
        index_data = load_index(root)
        wiki_recs = _wiki_records(index_data)
        self.assertEqual({record["path"] for record in wiki_recs}, {
            ".agentrail/context/wiki/overview.md",
            ".agentrail/context/wiki/unit__pkg-a.md",
            ".agentrail/context/wiki/unit__pkg-b.md",
        })
        for record in wiki_recs:
            self.assertEqual(record["authority"], "generated")
            self.assertTrue(record["chunkIds"], "every wiki_doc record must have chunks")
        wiki_chunks = [chunk for chunk in index_data["chunks"] if chunk["sourceType"] == "wiki_doc"]
        self.assertTrue(wiki_chunks)
        # Markdown heading-aware chunking (chunks_for_source reuse): the
        # Responsibility/Structure/etc. sections show up as distinct chunks.
        headings = {tuple(chunk["headingPath"]) for chunk in wiki_chunks if chunk["headingPath"]}
        self.assertIn(("Responsibility",), headings)

    def test_wiki_doc_records_absent_when_disabled(self) -> None:
        root = make_repo(summary_mode="disabled")
        with _env(_REPO_WIKI_FLAG, None):
            build_index(root)
        index_data = load_index(root)
        self.assertEqual(_wiki_records(index_data), [])


# ---------------------------------------------------------------------------
# Citation post-validation (pure function + integration)
# ---------------------------------------------------------------------------


class CitationValidationTests(unittest.TestCase):
    def test_validate_citations_strips_non_roster_paths_only(self) -> None:
        text = "See `pkg_a/mod1.py` for details and `bogus/nope.py` too, also `run_mod1`."
        cleaned, removed = wiki.validate_citations(text, {"pkg_a/mod1.py"})
        self.assertEqual(removed, 1)
        self.assertIn("`pkg_a/mod1.py`", cleaned)
        self.assertNotIn("`bogus/nope.py`", cleaned)
        self.assertIn("bogus/nope.py", cleaned, "text is kept, only the false citation marker is stripped")
        self.assertIn("`run_mod1`", cleaned, "bare symbol names are not path claims and are left alone")

    def test_validate_citations_keeps_clean_text_unchanged(self) -> None:
        text = "See `pkg_a/mod1.py` and `pkg_b/helper.py`."
        cleaned, removed = wiki.validate_citations(text, {"pkg_a/mod1.py", "pkg_b/helper.py"})
        self.assertEqual(removed, 0)
        self.assertEqual(cleaned, text)

    def test_bogus_citation_from_provider_is_stripped_and_counted(self) -> None:
        mock_dir = Path(tempfile.mkdtemp())
        command = _write_mock(mock_dir)
        root = make_repo(summary_mode="custom-command", summary_command=command)
        plan = [{"relationships": "Calls into `pkg_b/nonexistent.py` for helpers."}] * 3
        with _wiki_on(**_plan_env(mock_dir, plan)):
            result = build_index(root)
        self.assertGreater(result["wikiReport"]["citationsRemoved"], 0)
        pkg_a_text = (wiki.wiki_dir_for(root) / "unit__pkg-a.md").read_text(encoding="utf-8")
        self.assertNotIn("`pkg_b/nonexistent.py`", pkg_a_text)


# ---------------------------------------------------------------------------
# CLI: build / status / show
# ---------------------------------------------------------------------------


class WikiCliTests(unittest.TestCase):
    def _run(self, argv: List[str]) -> tuple[int, str]:
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = run_context(argv)
        return code, buffer.getvalue()

    def test_build_requires_flag_and_mode(self) -> None:
        root = make_repo(summary_mode="disabled")
        with _env(_REPO_WIKI_FLAG, None):
            code, _ = self._run(["wiki", "build", "--target", str(root)])
        self.assertEqual(code, 2)

    def test_build_rejects_disabled_mode_even_with_flag(self) -> None:
        root = make_repo(summary_mode="disabled")
        with _wiki_on():
            code, _ = self._run(["wiki", "build", "--target", str(root)])
        self.assertEqual(code, 2)

    def test_build_status_show_happy_path(self) -> None:
        mock_dir = Path(tempfile.mkdtemp())
        command = _write_mock(mock_dir)
        root = make_repo(summary_mode="custom-command", summary_command=command)
        with _wiki_on():
            build_code, build_out = self._run(["wiki", "build", "--target", str(root), "--json"])
            self.assertEqual(build_code, 0)
            build_payload = json.loads(build_out)
            self.assertTrue(build_payload["compiled"])

            status_code, status_out = self._run(["wiki", "status", "--target", str(root), "--json"])
            self.assertEqual(status_code, 0)
            status_payload = json.loads(status_out)
            self.assertTrue(status_payload["compiled"])
            self.assertEqual(len(status_payload["pages"]), 3)
            self.assertTrue(all(page["stale"] is False for page in status_payload["pages"]))

            show_code, show_out = self._run(["wiki", "show", "wiki/overview", "--target", str(root)])
            self.assertEqual(show_code, 0)
            self.assertIn("## Responsibility", show_out)
            self.assertIn('slug: "wiki/overview"', show_out)

    def test_status_before_any_compile_is_honest(self) -> None:
        root = make_repo(summary_mode="disabled")
        code, out = self._run(["wiki", "status", "--target", str(root)])
        self.assertEqual(code, 0)
        self.assertIn("No wiki compiled yet", out)

    def test_show_missing_slug_is_a_clean_error(self) -> None:
        root = make_repo(summary_mode="disabled")
        code, _ = self._run(["wiki", "show", "wiki/nope", "--target", str(root)])
        self.assertEqual(code, 2)

    def test_force_rebuilds_even_when_unchanged(self) -> None:
        mock_dir = Path(tempfile.mkdtemp())
        command = _write_mock(mock_dir)
        root = make_repo(summary_mode="custom-command", summary_command=command)
        with _wiki_on():
            self._run(["wiki", "build", "--target", str(root)])
            overview_path = wiki.wiki_dir_for(root) / "overview.md"
            mtime_before = overview_path.stat().st_mtime_ns
            time.sleep(0.05)

            code, out = self._run(["wiki", "build", "--force", "--target", str(root), "--json"])
            self.assertEqual(code, 0)
            mtime_after = overview_path.stat().st_mtime_ns
        self.assertNotEqual(mtime_before, mtime_after, "--force must rewrite even hash-unchanged pages")
        # --force must not leak the env var past this one CLI invocation.
        self.assertNotEqual(os.environ.get(wiki.WIKI_FORCE_ENV), "1")


if __name__ == "__main__":
    unittest.main()

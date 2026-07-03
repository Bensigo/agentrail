"""Read-grounded live context metrics (issue #1037).

Exercises a real cited-vs-read comparison end to end:

* precision = read pack tokens / actual pack tokens (actual-selected denominator)
* recall = pre-existing modified files in pack / pre-existing modified files,
  with created files excluded and the no-diff case yielding a coverage count and
  NO recall value (never 0)
* free labels: waste (pack files never read) + miss (self-fetched reads)
* n/a-vs-0 hygiene: an engine with no transcript reports n/a, never a zero

Plus the classified git collector (M=pre-existing-modified vs A/untracked=created)
against a real temp repo so the recall denominator is grounded in real git.

Every test is bounded (pure function calls + tiny temp git repos) and cannot
hang: there is no network, no agent, no subprocess beyond local git.
"""
from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

from agentrail.context.live_metrics import compute_live_context_metrics
from agentrail.guardrails.adapters import git as git_adapter


def _coverage(engine="claude", status="ok", paths=()):
    """Build a readsCoverage dict shaped like usage_capture writes to run.json."""
    return {
        "engine": engine,
        "status": status,
        "files": [{"path": p} for p in paths],
    }


def _pack(*items):
    """Pack ``included`` items: each (path, tokenEstimate)."""
    return [{"path": p, "tokenEstimate": t} for p, t in items]


# --------------------------------------------------------------------------- #
# Precision (read pack tokens / actual pack tokens)                            #
# --------------------------------------------------------------------------- #
class TestPrecision:
    def test_precision_is_read_tokens_over_actual_pack_tokens(self):
        # Pack has 3 files totalling 1000 tokens; executor read 2 of them (700).
        included = _pack(("a.py", 400), ("b.py", 300), ("c.py", 300))
        reads = _coverage(paths=["a.py", "b.py"])
        m = compute_live_context_metrics(
            included=included,
            reads_coverage=reads,
            modified_preexisting=["a.py"],
        )
        assert m["precisionStatus"] == "ok"
        assert m["precision"] == 0.7  # 700 / 1000
        assert m["readTokens"] == 700
        assert m["packTokens"] == 1000

    def test_denominator_is_actual_pack_not_fixed_budget(self):
        # A tiny fully-read pack scores 1.0 — the whole point vs precision_at_budget,
        # which would divide by the fixed RETRIEVAL_MAX_TOKENS and score low.
        included = _pack(("only.py", 120))
        m = compute_live_context_metrics(
            included=included,
            reads_coverage=_coverage(paths=["only.py"]),
            modified_preexisting=["only.py"],
        )
        assert m["precision"] == 1.0

    def test_reading_a_file_not_in_pack_does_not_exceed_one(self):
        included = _pack(("a.py", 500))
        # executor read a.py plus something the pack never had
        m = compute_live_context_metrics(
            included=included,
            reads_coverage=_coverage(paths=["a.py", "elsewhere.py"]),
            modified_preexisting=["a.py"],
        )
        assert m["precision"] == 1.0
        assert m["miss"] == ["elsewhere.py"]

    def test_empty_pack_precision_is_na_not_divide_by_zero(self):
        m = compute_live_context_metrics(
            included=[],
            reads_coverage=_coverage(paths=["a.py"]),
            modified_preexisting=["a.py"],
        )
        assert m["precision"] is None
        assert m["precisionStatus"] == "n/a"


# --------------------------------------------------------------------------- #
# Waste + miss free labels (AC4)                                              #
# --------------------------------------------------------------------------- #
class TestWasteAndMiss:
    def test_waste_is_pack_files_never_read(self):
        included = _pack(("read.py", 100), ("unread1.py", 100), ("unread2.py", 100))
        m = compute_live_context_metrics(
            included=included,
            reads_coverage=_coverage(paths=["read.py"]),
            modified_preexisting=["read.py"],
        )
        assert m["waste"] == ["unread1.py", "unread2.py"]

    def test_miss_is_self_fetched_files_not_in_pack(self):
        included = _pack(("packed.py", 100))
        m = compute_live_context_metrics(
            included=included,
            reads_coverage=_coverage(paths=["packed.py", "self_fetched.py"]),
            modified_preexisting=["packed.py"],
        )
        assert m["miss"] == ["self_fetched.py"]
        assert m["waste"] == []


# --------------------------------------------------------------------------- #
# Recall (pre-existing modified in pack / pre-existing modified)              #
# --------------------------------------------------------------------------- #
class TestRecall:
    def test_recall_over_preexisting_modified_files(self):
        included = _pack(("a.py", 100), ("b.py", 100))
        # 2 pre-existing files modified; only a.py was in the pack -> 0.5
        m = compute_live_context_metrics(
            included=included,
            reads_coverage=_coverage(paths=["a.py"]),
            modified_preexisting=["a.py", "z.py"],
        )
        assert m["recallStatus"] == "ok"
        assert m["recall"] == 0.5
        assert m["recallCovered"] == 1
        assert m["modifiedPreexistingCount"] == 2

    def test_created_files_excluded_from_denominator(self):
        # Pack has a.py. Modified pre-existing: a.py. Also created new.py (NOT
        # counted). Recall must be 1.0 (1/1), not 0.5 (1/2).
        included = _pack(("a.py", 100))
        m = compute_live_context_metrics(
            included=included,
            reads_coverage=_coverage(paths=["a.py"]),
            modified_preexisting=["a.py"],
            created_files=["new.py"],
        )
        assert m["recall"] == 1.0
        assert m["modifiedPreexistingCount"] == 1

    def test_file_listed_both_modified_and_created_is_treated_as_created(self):
        included = _pack(("a.py", 100))
        m = compute_live_context_metrics(
            included=included,
            reads_coverage=_coverage(paths=["a.py"]),
            modified_preexisting=["a.py", "weird.py"],
            created_files=["weird.py"],
        )
        # weird.py drops out of the denominator -> 1/1
        assert m["recall"] == 1.0
        assert m["modifiedPreexistingCount"] == 1

    def test_no_diff_run_is_coverage_count_not_recall_zero(self):
        # AC2: no pre-existing file modified -> recall is None, status no-diff,
        # NEVER recall == 0.
        included = _pack(("a.py", 100))
        m = compute_live_context_metrics(
            included=included,
            reads_coverage=_coverage(paths=["a.py"]),
            modified_preexisting=[],
        )
        assert m["recall"] is None
        assert m["recall"] != 0
        assert m["recallStatus"] == "no-diff"
        assert m["modifiedPreexistingCount"] == 0

    def test_created_only_run_has_no_recall_value(self):
        included = _pack(("a.py", 100))
        m = compute_live_context_metrics(
            included=included,
            reads_coverage=_coverage(paths=["a.py"]),
            modified_preexisting=[],
            created_files=["brand_new.py"],
        )
        assert m["recall"] is None
        assert m["recallStatus"] == "created-only"

    def test_recall_cross_check_flags_modified_file_neither_packed_nor_read(self):
        included = _pack(("a.py", 100))
        # z.py modified, not in pack, not read -> hard recall miss surfaced
        m = compute_live_context_metrics(
            included=included,
            reads_coverage=_coverage(paths=["a.py"]),
            modified_preexisting=["a.py", "z.py"],
        )
        assert m["recallMissedUnread"] == ["z.py"]


# --------------------------------------------------------------------------- #
# n/a-vs-0 hygiene (AC3): engines with no transcript vehicle                   #
# --------------------------------------------------------------------------- #
class TestEngineHygiene:
    def test_cursor_engine_reports_na_never_zero(self):
        # usage_capture returns status="n/a" for cursor/hermes.
        included = _pack(("a.py", 500))
        m = compute_live_context_metrics(
            included=included,
            reads_coverage=_coverage(engine="cursor", status="n/a"),
            modified_preexisting=["a.py"],
        )
        assert m["engine"] == "cursor"
        assert m["readStatus"] == "n/a"
        assert m["precision"] is None
        assert m["precisionStatus"] == "n/a"
        assert m["precision"] != 0
        # read-derived labels are n/a too — we can't know reads without a transcript
        assert m["waste"] is None
        assert m["miss"] is None

    def test_missing_coverage_reports_na(self):
        m = compute_live_context_metrics(
            included=_pack(("a.py", 100)),
            reads_coverage=None,
            modified_preexisting=["a.py"],
            engine_fallback="hermes",
        )
        assert m["engine"] == "hermes"
        assert m["readStatus"] == "n/a"
        assert m["precision"] is None

    def test_recall_still_computed_for_na_engine_from_diff(self):
        # Recall is diff-derived; it does not need a transcript. A cursor run
        # that DID modify a pre-existing file still gets a recall number.
        included = _pack(("a.py", 100))
        m = compute_live_context_metrics(
            included=included,
            reads_coverage=_coverage(engine="cursor", status="n/a"),
            modified_preexisting=["a.py"],
        )
        assert m["recall"] == 1.0
        # but no read cross-check for an n/a engine
        assert "recallMissedUnread" not in m

    def test_engine_tag_lowercased_and_defaulted(self):
        m = compute_live_context_metrics(
            included=_pack(("a.py", 100)),
            reads_coverage=_coverage(engine="Claude", status="ok", paths=["a.py"]),
            modified_preexisting=["a.py"],
        )
        assert m["engine"] == "claude"


# --------------------------------------------------------------------------- #
# Classified git collector (real temp repo)                                    #
# --------------------------------------------------------------------------- #
def _git(root: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)


def _init_repo(root: Path) -> None:
    _git(root, "init", "-b", "main")
    _git(root, "config", "user.email", "t@t.com")
    _git(root, "config", "user.name", "t")
    (root / "existing.py").write_text("x = 1\n")
    _git(root, "add", "-A")
    _git(root, "commit", "-m", "init")


class TestClassifiedGitCollector:
    def test_modified_preexisting_vs_created(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _init_repo(root)
            _git(root, "checkout", "-b", "work")
            # modify a pre-existing file
            (root / "existing.py").write_text("x = 2\n")
            # add a brand-new file, committed
            (root / "created.py").write_text("y = 1\n")
            _git(root, "add", "-A")
            _git(root, "commit", "-m", "change")
            # plus an untracked new file
            (root / "untracked.py").write_text("z = 1\n")

            modified, created = git_adapter.collect_classified_changes(
                root, base_ref="main"
            )

        assert modified == ["existing.py"]
        assert "created.py" in created
        assert "untracked.py" in created
        assert "existing.py" not in created

    def test_no_diff_yields_empty_modified(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _init_repo(root)
            # branch with no changes at all
            _git(root, "checkout", "-b", "work")

            modified, created = git_adapter.collect_classified_changes(
                root, base_ref="main"
            )

        assert modified == []
        assert created == []

    def test_feeds_live_metrics_no_diff_case_end_to_end(self):
        # Wire the real collector output into the metric: a no-diff run must
        # yield recall=None (coverage), not recall=0.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _init_repo(root)
            _git(root, "checkout", "-b", "work")
            modified, created = git_adapter.collect_classified_changes(
                root, base_ref="main"
            )
        m = compute_live_context_metrics(
            included=_pack(("existing.py", 100)),
            reads_coverage=_coverage(paths=["existing.py"]),
            modified_preexisting=modified,
            created_files=created,
        )
        assert m["recall"] is None
        assert m["recallStatus"] == "no-diff"

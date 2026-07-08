"""Adaptive confidence cutoff that trims the pack tail (issue #1096).

file-level precision (PR #1094) measured ``filePrecisionInPack`` 0.41 against
``fileRPrecision`` 0.80 on the fixture corpus: the ranker puts the right files on
top, but the packer dilutes the pack with low-confidence noise.  This cutoff drops
that tail using a RELATIVE threshold on ``score.final`` — keep candidates whose
final score is >= ``minScoreRatio * max(score.final)``, move the rest to
``excluded``.  Relative (not absolute) is required: an absolute threshold is
fragile across queries.

The joint bar is never precision alone: ``fileRecall`` must not drop.  Because
``filePrecisionInPack`` is a gameable order-invariant set fraction, a trim is only
honest to certify on the NON-saturated fixtures (#1088 AC3 / #1095), where recall
has headroom to register a loss.  These tests:

  * prove flag-OFF (the default) is byte-identical to today,
  * certify the lift on the two -hard fixtures with recall held,
  * prove no corpus fixture loses recall at the shipped ratio 0.4, and
  * prove an over-aggressive ratio (0.6) IS caught by a recall regression — the
    recall trap firing red is the guard rail working (AC2).
"""
from __future__ import annotations

import os
import unittest
from contextlib import contextmanager
from pathlib import Path
from typing import Dict, Iterator, Optional, Tuple

from agentrail.context import evaluation as ev
from agentrail.context.config import read_context_config
from agentrail.context.retrieval import query_context, resolve_pack_cutoff

REPO_ROOT = Path(__file__).parent.parent.parent
RETRIEVAL_FIXTURE_FILE = REPO_ROOT / "agentrail" / "context" / "retrieval-fixtures.json"

CUTOFF_ENV = "AGENTRAIL_CONTEXT_PACK_CUTOFF"
RATIO_ENV = "AGENTRAIL_CONTEXT_PACK_CUTOFF_RATIO"

# The #1095 non-saturated fixtures: the only ones where a trim can be honestly
# certified, because recall has headroom to fall.
HARD_FIXTURES = ("context-index-build-hard", "context-pack-build-hard")


@contextmanager
def _cutoff_env(enabled: Optional[bool], ratio: Optional[float]) -> Iterator[None]:
    """Set/clear the cutoff env vars for the block, restoring prior values after."""
    prior = {key: os.environ.get(key) for key in (CUTOFF_ENV, RATIO_ENV)}
    try:
        if enabled is None:
            os.environ.pop(CUTOFF_ENV, None)
        else:
            os.environ[CUTOFF_ENV] = "1" if enabled else "0"
        if ratio is None:
            os.environ.pop(RATIO_ENV, None)
        else:
            os.environ[RATIO_ENV] = str(ratio)
        yield
    finally:
        for key, value in prior.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def _eval_file_level(enabled: Optional[bool], ratio: Optional[float]) -> Dict[str, Tuple[float, float]]:
    """Run the corpus eval under the given cutoff env and return
    ``{name: (precisionInPack, recall)}`` for every scored fixture."""
    with _cutoff_env(enabled, ratio):
        report = ev.evaluate_retrieval(REPO_ROOT, RETRIEVAL_FIXTURE_FILE)
    out: Dict[str, Tuple[float, float]] = {}
    for fixture in report["fixtures"]:
        if fixture["status"] == "skipped":
            continue
        flp = fixture["metrics"]["fileLevelPrecision"]
        out[fixture["name"]] = (flp["precisionInPack"], flp["recall"])
    return out


class PackCutoffResolverTests(unittest.TestCase):
    """``resolve_pack_cutoff`` wires config (product path, AC4) + env (eval toggle)."""

    def test_default_is_off_at_ratio_0_4(self) -> None:
        # No env, repo config does not enable it → default-OFF, default ratio.
        with _cutoff_env(None, None):
            enabled, ratio = resolve_pack_cutoff(REPO_ROOT)
        self.assertFalse(enabled)
        self.assertEqual(ratio, 0.4)

    def test_env_flag_enables(self) -> None:
        with _cutoff_env(True, None):
            enabled, ratio = resolve_pack_cutoff(REPO_ROOT)
        self.assertTrue(enabled)
        self.assertEqual(ratio, 0.4)

    def test_env_ratio_overrides(self) -> None:
        with _cutoff_env(True, 0.6):
            enabled, ratio = resolve_pack_cutoff(REPO_ROOT)
        self.assertTrue(enabled)
        self.assertEqual(ratio, 0.6)

    def test_config_drives_enable_and_ratio(self) -> None:
        import json
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".agentrail").mkdir()
            (root / ".agentrail" / "config.json").write_text(
                json.dumps({"context": {"packCutoff": {"enabled": True, "minScoreRatio": 0.55}}}),
                encoding="utf-8",
            )
            # The config alone must enable it (env cleared) — that is the product path.
            with _cutoff_env(None, None):
                enabled, ratio = resolve_pack_cutoff(root)
            self.assertTrue(enabled)
            self.assertEqual(ratio, 0.55)
            # read_context_config default is OFF/0.4 for a bare project.
            self.assertFalse(read_context_config(REPO_ROOT).packCutoff.enabled)
            self.assertEqual(read_context_config(REPO_ROOT).packCutoff.minScoreRatio, 0.4)


class PackCutoffNoOpTests(unittest.TestCase):
    """AC3: flag-OFF is byte-identical to today (the cutoff branch never fires)."""

    @classmethod
    def setUpClass(cls) -> None:
        fixtures = {fx["name"]: fx for fx in ev.load_fixtures(RETRIEVAL_FIXTURE_FILE)}
        cls.task = fixtures["context-pack-build-hard"]["task"]

    def _query(self, enabled: Optional[bool], ratio: Optional[float]) -> Dict[str, object]:
        with _cutoff_env(enabled, ratio):
            return query_context(REPO_ROOT, self.task, limit=10)

    @staticmethod
    def _fingerprint(query: Dict[str, object]) -> Tuple[tuple, tuple]:
        results = tuple(
            (item.get("rank"), item.get("path"), item.get("chunkId")) for item in query.get("results", [])
        )
        excluded = tuple(sorted(str(item.get("citation") or item.get("path")) for item in query.get("excluded", [])))
        return results, excluded

    def test_flag_off_leaves_no_cutoff_marker(self) -> None:
        off = self._query(None, None)
        self.assertTrue(off.get("results"), "expected the fixture to retrieve candidates")
        self.assertFalse(
            [item for item in off.get("excluded", []) if "packCutoff" in item],
            "flag-OFF must not tag any excluded item with a pack cutoff",
        )

    def test_flag_off_equals_keep_all_ratio(self) -> None:
        # Enabling the machinery with a keep-everything ratio (0.0) must produce the
        # SAME results and excluded set as OFF — proving the feature adds nothing when
        # it drops nothing, i.e. OFF is a strict no-op.
        off = self._fingerprint(self._query(None, None))
        keep_all = self._fingerprint(self._query(True, 0.0))
        self.assertEqual(off, keep_all)


class PackCutoffCertificationTests(unittest.TestCase):
    """AC1/AC2: the lift is real on the non-saturated fixtures and the recall trap fires."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.off = _eval_file_level(None, None)
        cls.on4 = _eval_file_level(True, 0.4)
        cls.on6 = _eval_file_level(True, 0.6)

    def test_hard_fixtures_precision_up_recall_not_worse(self) -> None:
        """AC1: on #1095 fixtures, precisionInPack rises and recall does not drop (ratio 0.4)."""
        for name in HARD_FIXTURES:
            with self.subTest(fixture=name):
                off_prec, off_recall = self.off[name]
                on_prec, on_recall = self.on4[name]
                self.assertGreater(
                    on_prec,
                    off_prec,
                    f"{name}: precisionInPack should rise ({off_prec} -> {on_prec})",
                )
                self.assertGreaterEqual(
                    on_recall,
                    off_recall,
                    f"{name}: recall must not drop ({off_recall} -> {on_recall})",
                )

    def test_no_corpus_recall_regression_at_shipped_ratio(self) -> None:
        """AC1 guard rail: enabling at ratio 0.4 drops no fixture's recall below baseline."""
        for name, (_, off_recall) in self.off.items():
            with self.subTest(fixture=name):
                self.assertGreaterEqual(
                    self.on4[name][1],
                    off_recall,
                    f"{name}: recall regressed at ratio 0.4",
                )

    def test_recall_trap_fires_when_cutoff_too_aggressive(self) -> None:
        """AC2: an over-aggressive ratio (0.6) IS caught by a recall regression."""
        regressed = [name for name, (_, off_recall) in self.off.items() if self.on6[name][1] < off_recall]
        self.assertTrue(
            regressed,
            "an over-aggressive cutoff should drop at least one fixture's recall below baseline; "
            "the recall trap did not fire",
        )


if __name__ == "__main__":
    unittest.main()

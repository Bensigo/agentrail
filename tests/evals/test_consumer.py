"""Tests for the consumer/apply core (issue #1048).

Covers the acceptance criteria directly:

- **AC1** (``test_default_build_and_render_write_nothing``): the default path —
  :func:`parse_report` → :func:`build_proposal` → :func:`render_proposal` —
  touches no file on disk.
- **AC2** (``test_apply_writes_exactly_as_proposed``): what ``--apply`` writes is
  byte-for-byte what the proposal carried (overrides file WITH its trailing
  newline; routing edit via the real ``_apply_routing``).
- **AC3** (``test_apply_fails_closed_when_unlinked``): with no server link the
  apply refuses and writes nothing — the fail-CLOSED contrast to the GitHub
  webhook's fail-OPEN ``if (!secret) return true`` skip.

Plus unit coverage of the reverse parsers, the section-scoped report parser
(rerank-collision safety + :class:`ReportParseError`), the three-outcome
gate rule, and a render→parse round-trip against the REAL reporter output so
the parser can never silently drift from what the reporter emits.
"""
from __future__ import annotations

import json
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from agentrail.evals.arms import NEW_FLOW_LAYERS
from agentrail.evals.consumer import (
    ApplyAuthError,
    LayerChange,
    NewFlowFacts,
    Proposal,
    ReportFacts,
    ReportParseError,
    RoutingFacts,
    _parse_signed_pct,
    _parse_signed_seconds,
    _parse_signed_usd,
    apply_proposal,
    build_proposal,
    parse_report,
    render_proposal,
)
from agentrail.evals.reporter import ArmReport, render_markdown
from agentrail.run.routing import cheaper_model

# A server link that satisfies apply's fail-closed check without touching the
# real network or a real .agentrail/server.json.
def _linked(_target: Path) -> dict:
    return {
        "base_url": "https://example.test",
        "api_key": "test-key",
        "repository_id": "repo-1",
    }


def _unlinked(_target: Path) -> None:
    return None


def _snapshot_tree(root: Path) -> dict:
    """Map every file under ``root`` to its bytes — for no-write assertions."""
    return {
        p: p.read_bytes()
        for p in root.rglob("*")
        if p.is_file()
    }


# --- Reverse parsers -------------------------------------------------------


class SignedParserTests(unittest.TestCase):
    def test_signed_pct(self) -> None:
        self.assertAlmostEqual(_parse_signed_pct("+3.2%"), 0.032)
        self.assertAlmostEqual(_parse_signed_pct("-20.0%"), -0.20)
        self.assertAlmostEqual(_parse_signed_pct("  +0.0%  "), 0.0)

    def test_signed_pct_na_and_garbage(self) -> None:
        self.assertIsNone(_parse_signed_pct("n/a"))
        self.assertIsNone(_parse_signed_pct("3.2%"))  # unsigned → not a delta
        self.assertIsNone(_parse_signed_pct(""))

    def test_signed_usd(self) -> None:
        self.assertAlmostEqual(_parse_signed_usd("-$0.3400"), -0.34)
        self.assertAlmostEqual(_parse_signed_usd("+$1.0000"), 1.0)

    def test_signed_usd_na_and_garbage(self) -> None:
        self.assertIsNone(_parse_signed_usd("n/a"))
        self.assertIsNone(_parse_signed_usd("$1.0000"))  # unsigned
        self.assertIsNone(_parse_signed_usd("-1.0000"))  # no dollar sign

    def test_signed_seconds(self) -> None:
        self.assertAlmostEqual(_parse_signed_seconds("-4.0s"), -4.0)
        self.assertAlmostEqual(_parse_signed_seconds("+2.5s"), 2.5)
        self.assertAlmostEqual(_parse_signed_seconds("0.0s"), 0.0)

    def test_signed_seconds_na_and_garbage(self) -> None:
        self.assertIsNone(_parse_signed_seconds("n/a"))
        self.assertIsNone(_parse_signed_seconds("4.0"))  # no unit


# --- Report parsing (section scoping + errors) -----------------------------


# A minimal report whose New-flow section neighbours a rerank section with
# IDENTICAL row labels and an identical sentinel prefix. If the parser weren't
# section-scoped, the rerank rows would clobber the new-flow deltas.
_TWO_SECTION_REPORT = """# Eval report

## New-flow vs full

| Metric | full | new-flow | Delta (new-flow - full) |
| --- | ---: | ---: | ---: |
| Solve-rate | 60.0% | 80.0% | +20.0% |
| Dollars-per-solved-task | $1.0000 | $0.5000 | -$0.5000 |
| Wall-time per task | 40.0s | 36.0s | -4.0s |
| False-green rate | 20.0% | 0.0% | -20.0% |

## Rerank arm (full vs full-minus-rerank)

| Metric | full | full-minus-rerank | Delta (full - full-minus-rerank) |
| --- | ---: | ---: | ---: |
| Solve-rate | 60.0% | 10.0% | -99.0% |
| Dollars-per-solved-task | $1.0000 | $9.0000 | +$9.0000 |
| Wall-time per task | 40.0s | 99.0s | +99.0s |
| False-green rate | 20.0% | 99.0% | +99.0% |

## Routing cost-regret

- Total routing cost-regret: $2.5000
- Net $-delta vs baseline: +$1.2500 (positive = overspend)
"""


class ParseReportTests(unittest.TestCase):
    def test_section_scoped_ignores_rerank_rows(self) -> None:
        with TemporaryDirectory() as td:
            p = Path(td) / "eval-report-x.md"
            p.write_text(_TWO_SECTION_REPORT, encoding="utf-8")
            facts = parse_report(p)
        nf = facts.new_flow
        self.assertTrue(nf.available)
        # New-flow deltas, NOT the rerank section's -99% / +$9 / +99s values.
        self.assertAlmostEqual(nf.solve_rate_delta, 0.20)
        self.assertAlmostEqual(nf.dollars_per_solved_delta, -0.50)
        self.assertAlmostEqual(nf.wall_time_delta, -4.0)
        self.assertAlmostEqual(nf.false_green_rate_delta, -0.20)
        # Evidence rows are the new-flow rows.
        self.assertIn("80.0%", nf.rows["Solve-rate"])

    def test_routing_lines_parsed(self) -> None:
        with TemporaryDirectory() as td:
            p = Path(td) / "eval-report-x.md"
            p.write_text(_TWO_SECTION_REPORT, encoding="utf-8")
            facts = parse_report(p)
        self.assertAlmostEqual(facts.routing.total_regret_usd, 2.5)
        self.assertAlmostEqual(facts.routing.net_delta_usd, 1.25)

    def test_non_report_raises(self) -> None:
        with TemporaryDirectory() as td:
            p = Path(td) / "not-a-report.md"
            p.write_text("# Some other markdown\n\nNo eval anchors here.\n",
                         encoding="utf-8")
            with self.assertRaises(ReportParseError):
                parse_report(p)

    def test_new_flow_only_report_parses(self) -> None:
        # Header present but no routing section → parses, routing absent.
        with TemporaryDirectory() as td:
            p = Path(td) / "eval-report-x.md"
            p.write_text(
                "## New-flow vs full\n\n"
                "_Not available: only one arm ran._\n",
                encoding="utf-8",
            )
            facts = parse_report(p)
        self.assertFalse(facts.new_flow.available)
        self.assertEqual(facts.new_flow.sentinel, "_Not available: only one arm ran._")
        self.assertIsNone(facts.routing.regret_line)


# --- The three-outcome gate rule (build_proposal, layer stream) ------------


def _facts_with_deltas(
    *,
    solve: float | None,
    dollars: float | None,
    wall: float | None,
    fg: float | None,
    available: bool = True,
) -> ReportFacts:
    rows = {
        label: f"| {label} | ... |"
        for label in (
            "Solve-rate",
            "Dollars-per-solved-task",
            "Wall-time per task",
            "False-green rate",
        )
    } if available else {}
    nf = NewFlowFacts(
        available=available,
        rows=rows,
        solve_rate_delta=solve,
        dollars_per_solved_delta=dollars,
        wall_time_delta=wall,
        false_green_rate_delta=fg,
    )
    return ReportFacts(
        path=Path("eval-report-x.md"),
        name="eval-report-x.md",
        new_flow=nf,
        routing=RoutingFacts(),
    )


class GateRuleTests(unittest.TestCase):
    def test_all_gates_pass_pins_new_flow_layers_true(self) -> None:
        facts = _facts_with_deltas(solve=0.20, dollars=-0.50, wall=-4.0, fg=-0.20)
        with TemporaryDirectory() as td:
            proposal = build_proposal(facts, Path(td))
        self.assertEqual(
            [(c.name, c.value) for c in proposal.layer_changes],
            [(layer, True) for layer in NEW_FLOW_LAYERS],
        )
        self.assertIsNotNone(proposal.overrides_content)

    def test_any_gate_fails_pins_new_flow_layers_false(self) -> None:
        # Dollars went UP (>= 0) → fails the "< 0" gate.
        facts = _facts_with_deltas(solve=0.20, dollars=0.10, wall=-4.0, fg=-0.20)
        with TemporaryDirectory() as td:
            proposal = build_proposal(facts, Path(td))
        self.assertEqual(
            [(c.name, c.value) for c in proposal.layer_changes],
            [(layer, False) for layer in NEW_FLOW_LAYERS],
        )

    def test_unknown_only_proposes_no_change(self) -> None:
        # One gate n/a, none failing → no layer change at all.
        facts = _facts_with_deltas(solve=0.20, dollars=None, wall=-4.0, fg=-0.20)
        with TemporaryDirectory() as td:
            proposal = build_proposal(facts, Path(td))
        self.assertEqual(proposal.layer_changes, [])
        self.assertIsNone(proposal.overrides_content)

    def test_unavailable_new_flow_proposes_no_change(self) -> None:
        facts = _facts_with_deltas(
            solve=None, dollars=None, wall=None, fg=None, available=False
        )
        with TemporaryDirectory() as td:
            proposal = build_proposal(facts, Path(td))
        self.assertEqual(proposal.layer_changes, [])


# --- AC1: default path writes nothing --------------------------------------


class AC1NoWriteTests(unittest.TestCase):
    def test_default_build_and_render_write_nothing(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            report = root / "eval-report-x.md"
            report.write_text(_TWO_SECTION_REPORT, encoding="utf-8")
            before = _snapshot_tree(root)

            facts = parse_report(report)
            proposal = build_proposal(facts, root)
            text = render_proposal(proposal)

            after = _snapshot_tree(root)
            # Nothing created, nothing modified: the report is the only file,
            # and no .agentrail/ directory was materialised.
            self.assertEqual(before, after)
            self.assertNotIn(".agentrail", os.listdir(td))
        # The rendered proposal announces its read-only mode.
        self.assertIn("Mode: proposal only", text)
        self.assertIn("--apply", text)


# --- AC2: apply writes exactly as proposed ---------------------------------


class AC2ExactApplyTests(unittest.TestCase):
    def test_apply_writes_exactly_as_proposed(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            # A checkout that pins an expensive model with a cheaper tier.
            agentrail_dir = root / ".agentrail"
            agentrail_dir.mkdir()
            (agentrail_dir / "config.json").write_text(
                json.dumps(
                    {"runners": {"default": {"models": {"execute": "claude-opus-4-8"}}}},
                    indent=2,
                ),
                encoding="utf-8",
            )
            # A report: all four gates pass (→ pin ON) AND measured overspend
            # (→ routing step-down).
            report = root / "eval-report-x.md"
            report.write_text(_TWO_SECTION_REPORT, encoding="utf-8")

            facts = parse_report(report)
            proposal = build_proposal(facts, root)

            # The exact bytes the proposal SAYS it will write for the overrides.
            expected_overrides_bytes = (
                json.dumps(proposal.overrides_content, indent=2) + "\n"
            ).encode("utf-8")
            expected_cheaper = cheaper_model("claude-opus-4-8")

            lines = apply_proposal(proposal, root, link_loader=_linked)

            # Overrides file written byte-for-byte as proposed, WITH newline.
            overrides_file = agentrail_dir / "layer-overrides.json"
            self.assertEqual(overrides_file.read_bytes(), expected_overrides_bytes)
            written = json.loads(overrides_file.read_text(encoding="utf-8"))
            for layer in NEW_FLOW_LAYERS:
                self.assertIs(written["layers"][layer], True)
            self.assertEqual(written["source"], "eval-report-x.md")

            # Routing edit applied to config.json via _apply_routing (cheaper
            # tier computed by cheaper_model, NOT hardcoded here).
            cfg = json.loads((agentrail_dir / "config.json").read_text(encoding="utf-8"))
            self.assertEqual(
                cfg["runners"]["default"]["models"]["execute"], expected_cheaper
            )
        # Result lines report both applies.
        joined = "\n".join(lines)
        self.assertIn("layer-overrides.json", joined)
        self.assertIn(expected_cheaper, joined)

    def test_apply_overrides_merges_and_preserves_unrelated_pins(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            agentrail_dir = root / ".agentrail"
            agentrail_dir.mkdir()
            # Pre-existing unrelated pin should survive the merge.
            (agentrail_dir / "layer-overrides.json").write_text(
                json.dumps({"layers": {"diff_only_enforce": False}}, indent=2) + "\n",
                encoding="utf-8",
            )
            report = root / "eval-report-x.md"
            report.write_text(_TWO_SECTION_REPORT, encoding="utf-8")

            facts = parse_report(report)
            proposal = build_proposal(facts, root)
            apply_proposal(proposal, root, link_loader=_linked)

            written = json.loads(
                (agentrail_dir / "layer-overrides.json").read_text(encoding="utf-8")
            )
        self.assertIs(written["layers"]["diff_only_enforce"], False)  # preserved
        for layer in NEW_FLOW_LAYERS:
            self.assertIs(written["layers"][layer], True)  # added


# --- AC3: fail-closed apply ------------------------------------------------


class AC3FailClosedTests(unittest.TestCase):
    def setUp(self) -> None:
        # load_link also reads AGENTRAIL_SERVER_* env; pop them so the injected
        # _unlinked loader is the sole authority for this test.
        self._saved = {
            k: os.environ.pop(k, None)
            for k in (
                "AGENTRAIL_SERVER_BASE_URL",
                "AGENTRAIL_SERVER_API_KEY",
                "AGENTRAIL_SERVER_REPOSITORY_ID",
            )
        }

    def tearDown(self) -> None:
        for k, v in self._saved.items():
            if v is not None:
                os.environ[k] = v

    def test_apply_fails_closed_when_unlinked(self) -> None:
        # A proposal WITH changes: apply must still refuse and write nothing.
        # This is the fail-CLOSED contract. Contrast the GitHub webhook's
        # fail-OPEN `verifySignature`: `if (!secret) return true` SKIPS the
        # check when the secret is unset. Here, an unconfigured link REJECTS.
        with TemporaryDirectory() as td:
            root = Path(td)
            agentrail_dir = root / ".agentrail"
            agentrail_dir.mkdir()
            (agentrail_dir / "config.json").write_text(
                json.dumps(
                    {"runners": {"default": {"models": {"execute": "claude-opus-4-8"}}}},
                    indent=2,
                ),
                encoding="utf-8",
            )
            report = root / "eval-report-x.md"
            report.write_text(_TWO_SECTION_REPORT, encoding="utf-8")

            facts = parse_report(report)
            proposal = build_proposal(facts, root)
            self.assertTrue(proposal.has_changes)  # there IS something to write

            before = _snapshot_tree(root)
            with self.assertRaises(ApplyAuthError):
                apply_proposal(proposal, root, link_loader=_unlinked)
            after = _snapshot_tree(root)

        # Zero writes: no overrides file created, config.json untouched.
        self.assertEqual(before, after)
        self.assertNotIn(
            agentrail_dir / "layer-overrides.json", after,
        )

    def test_auth_checked_before_proposal_even_when_empty(self) -> None:
        # An EMPTY proposal must ALSO be rejected when unlinked — auth is
        # checked before the proposal is even inspected.
        empty = Proposal(report_name="x.md", report_path=Path("x.md"))
        self.assertFalse(empty.has_changes)
        with TemporaryDirectory() as td:
            with self.assertRaises(ApplyAuthError):
                apply_proposal(empty, Path(td), link_loader=_unlinked)


# --- Empty proposal apply (linked) -----------------------------------------


class EmptyProposalApplyTests(unittest.TestCase):
    def test_empty_proposal_apply_writes_nothing_but_reports(self) -> None:
        empty = Proposal(report_name="x.md", report_path=Path("x.md"))
        with TemporaryDirectory() as td:
            root = Path(td)
            before = _snapshot_tree(root)
            lines = apply_proposal(empty, root, link_loader=_linked)
            after = _snapshot_tree(root)
        self.assertEqual(before, after)  # linked, but nothing to write
        self.assertEqual(lines, ["Nothing to apply: the proposal contains no changes."])


# --- Render → parse round-trip against the REAL reporter -------------------


class RoundTripTests(unittest.TestCase):
    """Guards the parser against reporter render drift.

    Builds two arms with the real :class:`ArmReport`, renders with the real
    :func:`render_markdown`, and asserts the parser recovers the deltas the
    reporter computed. If the reporter changes a render string, this fails.
    """

    def _render_two_arm(self) -> str:
        full = ArmReport(
            "full", 5, 3, 2, 0.60, 0.0, 1000, 500, 0, 0, 1500, 3.00, 1.00,
            mean_wall_time_s=40.0, total_wall_time_s=200.0,
            gate_passed_count=3, false_green_count=1, false_green_rate=0.20,
        )
        new_flow = ArmReport(
            "new-flow", 5, 4, 1, 0.80, 0.0, 900, 400, 0, 0, 1300, 2.00, 0.50,
            mean_wall_time_s=36.0, total_wall_time_s=180.0,
            gate_passed_count=4, false_green_count=0, false_green_rate=0.0,
        )
        return render_markdown(
            [full, new_flow], generated_at="2026-06-29T00:00:00Z"
        )

    def test_roundtrip_recovers_deltas(self) -> None:
        md = self._render_two_arm()
        with TemporaryDirectory() as td:
            p = Path(td) / "eval-report-2026-06-29.md"
            p.write_text(md, encoding="utf-8")
            facts = parse_report(p)
        nf = facts.new_flow
        self.assertTrue(nf.available)
        # new-flow minus full: solve +0.20, dollars -0.50, wall -4.0, fg -0.20.
        self.assertAlmostEqual(nf.solve_rate_delta, 0.20)
        self.assertAlmostEqual(nf.dollars_per_solved_delta, -0.50)
        self.assertAlmostEqual(nf.wall_time_delta, -4.0)
        self.assertAlmostEqual(nf.false_green_rate_delta, -0.20)

    def test_roundtrip_all_gates_pass_end_to_end(self) -> None:
        md = self._render_two_arm()
        with TemporaryDirectory() as td:
            root = Path(td)
            p = root / "eval-report-2026-06-29.md"
            p.write_text(md, encoding="utf-8")
            facts = parse_report(p)
            proposal = build_proposal(facts, root)
        # This synthetic report is the #981 flip: all gates pass → pin ON.
        self.assertEqual(
            [(c.name, c.value) for c in proposal.layer_changes],
            [(layer, True) for layer in NEW_FLOW_LAYERS],
        )


if __name__ == "__main__":
    unittest.main()

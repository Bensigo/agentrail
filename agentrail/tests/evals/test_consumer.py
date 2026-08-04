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
from datetime import date
from pathlib import Path
from tempfile import TemporaryDirectory

from agentrail.evals.arms import NEW_FLOW_LAYERS
from agentrail.evals.consumer import (
    ApplyAuthError,
    ApplyReportGateError,
    ArmSummaryFacts,
    EvalCycleFacts,
    LayerChange,
    NewFlowFacts,
    Proposal,
    PromotionDecision,
    ProvenanceFacts,
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
from agentrail.evals.provenance import EvalCycle, EvalProvenance
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
_TWO_SECTION_REPORT = f"""# Eval report

Generated: {date.today().isoformat()}

## Evaluation provenance

| Input | SHA-256 |
| --- | --- |
| Code | {'a' * 64} |
| Config | {'b' * 64} |
| Corpus | {'c' * 64} |
| Answer key | {'f' * 64} |
| Scorer | {'d' * 64} |
| Gate | {'e' * 64} |

## Evaluation cycle

| Field | Value |
| --- | --- |
| Promotion grade | METADATA_COMPLETE — valid immutable metadata supplied |
| Cycle ID | eval-2026-08-04-001 |
| Parent cycle ID | none |
| Hypothesis | reduce false-green without cost regression |
| Changed layers | bestofn |
| Declared budget | $25 |
| Status | proposed |

## Per-arm summary

| Arm | Reps | Solved | Failed | Solve-rate | Spread | False-green rate | Wall-time per task | Total tokens | Total cost | Dollars-per-solved-task |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| full | 5 | 3 | 2 | 60.0% | 0.0000 | 0.0% | 40.0s | 1000 | $1.0000 | $1.0000 |
| new-flow | 5 | 4 | 1 | 80.0% | 0.0000 | 0.0% | 36.0s | 900 | $0.5000 | $0.5000 |

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
    def test_report_fingerprint_is_the_exact_file_content(self) -> None:
        import hashlib

        with TemporaryDirectory() as td:
            p = Path(td) / "eval-report-x.md"
            p.write_text(_TWO_SECTION_REPORT, encoding="utf-8")
            facts = parse_report(p)
        self.assertEqual(
            facts.content_sha256,
            hashlib.sha256(_TWO_SECTION_REPORT.encode("utf-8")).hexdigest(),
        )

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
        generated_at=date.today(),
        arm_summaries=[
            ArmSummaryFacts(
                arm="full",
                repetitions=5,
                solved=1,
                total_tokens=1000,
                total_cost_usd=1.0,
            )
        ],
        provenance=ProvenanceFacts(
            fingerprints={
                key: "a" * 64
                for key in (
                    "Code",
                    "Config",
                    "Corpus",
                    "Answer key",
                    "Scorer",
                    "Gate",
                )
            }
        ),
        eval_cycle=EvalCycleFacts(
            cycle_id="eval-2026-08-04-001",
            parent_cycle_id=None,
            hypothesis="reduce false-green without cost regression",
            changed_layers=("bestofn",),
            declared_budget_usd="25",
            status="proposed",
        ),
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
        self.assertEqual(proposal.promotion_decision, PromotionDecision.PROMOTE)

    def test_any_gate_fails_rejects_candidate_without_changing_default(self) -> None:
        # Dollars went UP (>= 0) → fails the "< 0" gate.
        facts = _facts_with_deltas(solve=0.20, dollars=0.10, wall=-4.0, fg=-0.20)
        with TemporaryDirectory() as td:
            proposal = build_proposal(facts, Path(td))
        self.assertEqual(proposal.promotion_decision, PromotionDecision.REJECT)
        self.assertEqual(proposal.layer_changes, [])
        self.assertIsNone(proposal.overrides_content)
        self.assertIn("Apply gate: REJECT", render_proposal(proposal))

    def test_unknown_only_proposes_no_change(self) -> None:
        # One gate n/a, none failing → no layer change at all.
        facts = _facts_with_deltas(solve=0.20, dollars=None, wall=-4.0, fg=-0.20)
        with TemporaryDirectory() as td:
            proposal = build_proposal(facts, Path(td))
        self.assertEqual(proposal.layer_changes, [])
        self.assertIsNone(proposal.overrides_content)
        self.assertEqual(proposal.promotion_decision, PromotionDecision.HOLD)

    def test_unavailable_new_flow_proposes_no_change(self) -> None:
        facts = _facts_with_deltas(
            solve=None, dollars=None, wall=None, fg=None, available=False
        )
        with TemporaryDirectory() as td:
            proposal = build_proposal(facts, Path(td))
        self.assertEqual(proposal.layer_changes, [])


class EvaluatorIntegrityTests(unittest.TestCase):
    def _child_report(self, *, answer_key: str = "f" * 64) -> str:
        return (
            _TWO_SECTION_REPORT.replace(
                "| Cycle ID | eval-2026-08-04-001 |",
                "| Cycle ID | eval-2026-08-05-001 |",
            )
            .replace(
                "| Parent cycle ID | none |",
                "| Parent cycle ID | eval-2026-08-04-001 |",
            )
            .replace(f"| Answer key | {'f' * 64} |", f"| Answer key | {answer_key} |")
        )

    def test_changed_answer_key_quarantines_the_child_before_apply(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            parent_path = root / "parent.md"
            child_path = root / "child.md"
            parent_path.write_text(_TWO_SECTION_REPORT, encoding="utf-8")
            child_path.write_text(self._child_report(answer_key="1" * 64), encoding="utf-8")

            proposal = build_proposal(
                parse_report(child_path), root, parent_facts=parse_report(parent_path)
            )

        self.assertTrue(proposal.is_held)
        self.assertFalse(proposal.has_changes)
        self.assertTrue(
            any("evaluator integrity quarantine" in reason for reason in proposal.hold_reasons)
        )

    def test_matching_parent_evaluator_allows_normal_promotion_gate(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            parent_path = root / "parent.md"
            child_path = root / "child.md"
            parent_path.write_text(_TWO_SECTION_REPORT, encoding="utf-8")
            child_path.write_text(self._child_report(), encoding="utf-8")

            proposal = build_proposal(
                parse_report(child_path), root, parent_facts=parse_report(parent_path)
            )

        self.assertEqual(proposal.promotion_decision, PromotionDecision.PROMOTE)
        self.assertTrue(proposal.has_changes)

    def test_declared_parent_without_parent_report_holds(self) -> None:
        with TemporaryDirectory() as td:
            child_path = Path(td) / "child.md"
            child_path.write_text(self._child_report(), encoding="utf-8")
            proposal = build_proposal(parse_report(child_path), Path(td))

        self.assertTrue(proposal.is_held)
        self.assertTrue(any("parent report was not supplied" in reason for reason in proposal.hold_reasons))

    def test_invalid_parent_cycle_metadata_holds(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            parent_path = root / "parent.md"
            child_path = root / "child.md"
            parent_path.write_text(
                _TWO_SECTION_REPORT.replace("| Status | proposed |", "| Status | invalid |"),
                encoding="utf-8",
            )
            child_path.write_text(self._child_report(), encoding="utf-8")
            proposal = build_proposal(
                parse_report(child_path), root, parent_facts=parse_report(parent_path)
            )

        self.assertTrue(proposal.is_held)
        self.assertTrue(any("parent report cycle lineage is incomplete" in reason for reason in proposal.hold_reasons))

    def test_malformed_cycle_metadata_holds_before_gate_evaluation(self) -> None:
        malformed = _TWO_SECTION_REPORT.replace(
            "| Cycle ID | eval-2026-08-04-001 |", "| Cycle ID | bad id |"
        )
        with TemporaryDirectory() as td:
            report = Path(td) / "malformed.md"
            report.write_text(malformed, encoding="utf-8")
            proposal = build_proposal(parse_report(report), Path(td))

        self.assertTrue(proposal.is_held)
        self.assertTrue(any("cycle id missing or malformed" in reason for reason in proposal.hold_reasons))


class ApplyEvidenceGateTests(unittest.TestCase):
    def test_stale_report_holds_and_never_writes(self) -> None:
        facts = _facts_with_deltas(solve=0.20, dollars=-0.50, wall=-4.0, fg=-0.20)
        facts.generated_at = date(2026, 8, 1)
        with TemporaryDirectory() as td:
            root = Path(td)
            proposal = build_proposal(
                facts,
                root,
                today=date(2026, 8, 4),
                max_report_age_days=1,
            )
            before = _snapshot_tree(root)
            with self.assertRaises(ApplyReportGateError):
                apply_proposal(proposal, root, link_loader=_linked)
            after = _snapshot_tree(root)
        self.assertTrue(proposal.is_held)
        self.assertFalse(proposal.has_changes)
        self.assertTrue(any("stale report" in reason for reason in proposal.hold_reasons))
        self.assertEqual(before, after)

    def test_zero_repetition_report_holds_and_never_writes(self) -> None:
        facts = _facts_with_deltas(solve=0.20, dollars=-0.50, wall=-4.0, fg=-0.20)
        facts.arm_summaries = [
            ArmSummaryFacts(
                arm="full",
                repetitions=0,
                solved=0,
                total_tokens=0,
                total_cost_usd=0.0,
            ),
            ArmSummaryFacts(
                arm="new-flow",
                repetitions=0,
                solved=0,
                total_tokens=0,
                total_cost_usd=0.0,
            ),
        ]
        with TemporaryDirectory() as td:
            root = Path(td)
            proposal = build_proposal(facts, root)
            before = _snapshot_tree(root)
            with self.assertRaises(ApplyReportGateError):
                apply_proposal(proposal, root, link_loader=_linked)
            after = _snapshot_tree(root)
        self.assertTrue(proposal.is_held)
        self.assertTrue(any("zero-evidence" in reason for reason in proposal.hold_reasons))
        self.assertIn("Apply gate: HOLD", render_proposal(proposal))
        self.assertEqual(before, after)

    def test_underpowered_report_holds_before_auth_or_write(self) -> None:
        facts = _facts_with_deltas(solve=0.20, dollars=-0.50, wall=-4.0, fg=-0.20)
        facts.arm_summaries[0] = ArmSummaryFacts("full", 4, 3, 1000, 1.0)
        with TemporaryDirectory() as td:
            root = Path(td)
            proposal = build_proposal(facts, root)
            with self.assertRaises(ApplyReportGateError):
                apply_proposal(proposal, root, link_loader=_linked)
        self.assertTrue(proposal.is_held)
        self.assertTrue(any("underpowered" in reason for reason in proposal.hold_reasons))

    def test_synthetic_only_report_holds_explicitly(self) -> None:
        facts = _facts_with_deltas(solve=0.20, dollars=-0.50, wall=-4.0, fg=-0.20)
        facts.arm_summaries[0] = ArmSummaryFacts("full", 0, 0, 0, 0.0)
        facts.network_artifact_count = 5
        proposal = build_proposal(facts, Path("."))
        self.assertTrue(proposal.is_held)
        self.assertTrue(any("synthetic-only" in reason for reason in proposal.hold_reasons))

    def test_missing_or_invalid_provenance_holds(self) -> None:
        facts = _facts_with_deltas(solve=0.20, dollars=-0.50, wall=-4.0, fg=-0.20)
        facts.provenance = ProvenanceFacts(fingerprints={"Code": "not-a-hash"})
        proposal = build_proposal(facts, Path("."))
        self.assertTrue(proposal.is_held)
        self.assertTrue(any("lineage is incomplete" in reason for reason in proposal.hold_reasons))

    def test_parsed_synthetic_only_report_holds_explicitly(self) -> None:
        report_text = _TWO_SECTION_REPORT.replace(
            "| full | 5 | 3 | 2 |", "| full | 0 | 0 | 0 |"
        ).replace(
            "| new-flow | 5 | 4 | 1 |", "| new-flow | 0 | 0 | 0 |"
        ) + """

## Failures, ties, and spread

### Arm: full

- Network artifacts (excluded from all metrics): 5 ECONNRESET synthetic-fallback rep(s) — no diff, $0; solved=0 is a network artifact, not a real score
"""
        with TemporaryDirectory() as td:
            report = Path(td) / "eval-report-x.md"
            report.write_text(report_text, encoding="utf-8")
            proposal = build_proposal(parse_report(report), Path(td))
        self.assertTrue(proposal.is_held)
        self.assertTrue(any("synthetic-only" in reason for reason in proposal.hold_reasons))

    def test_parsed_underpowered_report_holds(self) -> None:
        report_text = _TWO_SECTION_REPORT.replace("| full | 5 | 3 | 2 |", "| full | 4 | 3 | 1 |")
        with TemporaryDirectory() as td:
            report = Path(td) / "eval-report-x.md"
            report.write_text(report_text, encoding="utf-8")
            proposal = build_proposal(parse_report(report), Path(td))
        self.assertTrue(proposal.is_held)
        self.assertTrue(any("underpowered" in reason for reason in proposal.hold_reasons))

    def test_missing_report_metadata_holds_instead_of_being_assumed_fresh(self) -> None:
        facts = ReportFacts(
            path=Path("legacy.md"),
            name="legacy.md",
            new_flow=NewFlowFacts(),
            routing=RoutingFacts(),
        )
        proposal = build_proposal(facts, Path("."))
        self.assertTrue(proposal.is_held)
        self.assertIn("freshness is unknown", proposal.hold_reasons[0])

    def test_rejected_candidate_never_writes_even_when_linked(self) -> None:
        facts = _facts_with_deltas(solve=0.20, dollars=0.10, wall=-4.0, fg=-0.20)
        with TemporaryDirectory() as td:
            root = Path(td)
            proposal = build_proposal(facts, root)
            before = _snapshot_tree(root)
            with self.assertRaises(ApplyReportGateError):
                apply_proposal(proposal, root, link_loader=_linked)
            after = _snapshot_tree(root)
        self.assertEqual(before, after)

    def test_apply_refuses_when_fingerprinted_report_changes(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            report = root / "eval-report-x.md"
            report.write_text(_TWO_SECTION_REPORT, encoding="utf-8")
            proposal = build_proposal(parse_report(report), root)
            report.write_text(
                _TWO_SECTION_REPORT + "\nmutated after proposal\n",
                encoding="utf-8",
            )
            before = _snapshot_tree(root)
            with self.assertRaisesRegex(ApplyReportGateError, "contents changed"):
                apply_proposal(proposal, root, link_loader=_linked)
            after = _snapshot_tree(root)
        self.assertEqual(before, after)

    def test_apply_refuses_when_parent_report_changes_after_proposal(self) -> None:
        child_text = (
            _TWO_SECTION_REPORT.replace(
                "| Cycle ID | eval-2026-08-04-001 |",
                "| Cycle ID | eval-2026-08-05-001 |",
            ).replace(
                "| Parent cycle ID | none |",
                "| Parent cycle ID | eval-2026-08-04-001 |",
            )
        )
        with TemporaryDirectory() as td:
            root = Path(td)
            parent = root / "parent.md"
            child = root / "child.md"
            parent.write_text(_TWO_SECTION_REPORT, encoding="utf-8")
            child.write_text(child_text, encoding="utf-8")
            proposal = build_proposal(
                parse_report(child), root, parent_facts=parse_report(parent)
            )
            parent.write_text(_TWO_SECTION_REPORT + "\nmutated parent\n", encoding="utf-8")

            with self.assertRaisesRegex(ApplyReportGateError, "parent report contents changed"):
                apply_proposal(proposal, root, link_loader=_linked)


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

    def test_unfingerprinted_proposal_is_rejected_before_auth(self) -> None:
        # A hand-built proposal has no immutable report source, so it cannot
        # be applied even when it is otherwise empty or unlinked.
        empty = Proposal(
            report_name="x.md",
            report_path=Path("x.md"),
            promotion_decision=PromotionDecision.PROMOTE,
        )
        self.assertFalse(empty.has_changes)
        with TemporaryDirectory() as td:
            with self.assertRaises(ApplyReportGateError):
                apply_proposal(empty, Path(td), link_loader=_unlinked)


# --- Empty proposal apply (linked) -----------------------------------------


class EmptyProposalApplyTests(unittest.TestCase):
    def test_empty_proposal_without_report_lineage_is_refused(self) -> None:
        empty = Proposal(report_name="x.md", report_path=Path("x.md"))
        with TemporaryDirectory() as td:
            root = Path(td)
            before = _snapshot_tree(root)
            with self.assertRaises(ApplyReportGateError):
                apply_proposal(empty, root, link_loader=_linked)
            after = _snapshot_tree(root)
        self.assertEqual(before, after)


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
            [full, new_flow],
            generated_at=f"{date.today().isoformat()}T00:00:00Z",
            provenance=EvalProvenance(
                code_sha256="a" * 64,
                config_sha256="b" * 64,
                corpus_sha256="c" * 64,
                answer_key_sha256="f" * 64,
                scorer_sha256="d" * 64,
                gate_sha256="e" * 64,
            ),
            eval_cycle=EvalCycle(
                cycle_id="eval-2026-08-04-001",
                parent_cycle_id=None,
                hypothesis="reduce false-green without cost regression",
                changed_layers=("bestofn",),
                declared_budget_usd="25",
                status="proposed",
            ),
        )

    def test_roundtrip_recovers_deltas(self) -> None:
        md = self._render_two_arm()
        with TemporaryDirectory() as td:
            p = Path(td) / "eval-report-2026-06-29.md"
            p.write_text(md, encoding="utf-8")
            facts = parse_report(p)
        nf = facts.new_flow
        self.assertTrue(nf.available)
        self.assertIsNotNone(facts.provenance)
        self.assertEqual(
            facts.provenance.fingerprints,
            {
                "Code": "a" * 64,
                "Config": "b" * 64,
                "Corpus": "c" * 64,
                "Answer key": "f" * 64,
                "Scorer": "d" * 64,
                "Gate": "e" * 64,
            },
        )
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

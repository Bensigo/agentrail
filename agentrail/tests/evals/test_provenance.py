"""Tests for immutable eval-input provenance (issue #1604)."""

from pathlib import Path

from agentrail.evals.arms import baseline
from agentrail.evals.provenance import EvalCycle, build_eval_provenance
from agentrail.evals.spine import SpineConfig


def _write_required_sources(package_root: Path) -> None:
    for relative in (
        "evals/scorer.py",
        "evals/run_record.py",
        "evals/hidden_tests.py",
        "evals/runner.py",
        "run/objective_gate.py",
    ):
        path = package_root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"# {relative}\n", encoding="utf-8")


def test_provenance_is_deterministic_and_identifies_the_changed_input(tmp_path: Path) -> None:
    package_root = tmp_path / "agentrail"
    corpus = tmp_path / "corpus"
    _write_required_sources(package_root)
    corpus.mkdir()
    (corpus / "task.json").write_text('{"name": "one"}\n', encoding="utf-8")
    config = SpineConfig(arms=[baseline()], reps=5, corpus_root=corpus)

    first = build_eval_provenance(
        config=config, package_root=package_root, corpus_root=corpus
    )
    second = build_eval_provenance(
        config=config, package_root=package_root, corpus_root=corpus
    )
    assert first == second

    # Every named bucket must move when its own underlying source changes;
    # otherwise a plausible-looking provenance table could silently stop
    # describing the evaluator that produced a promotion decision.
    code_source = package_root / "feature.py"
    code_source.write_text("# initial implementation\n", encoding="utf-8")
    with_code_source = build_eval_provenance(
        config=config, package_root=package_root, corpus_root=corpus
    )
    code_source.write_text("# changed implementation\n", encoding="utf-8")
    code_changed = build_eval_provenance(
        config=config, package_root=package_root, corpus_root=corpus
    )
    assert code_changed.code_sha256 != with_code_source.code_sha256

    scorer_source = package_root / "evals" / "scorer.py"
    scorer_source.write_text("# changed scorer\n", encoding="utf-8")
    scorer_changed = build_eval_provenance(
        config=config, package_root=package_root, corpus_root=corpus
    )
    assert scorer_changed.scorer_sha256 != code_changed.scorer_sha256

    gate_source = package_root / "evals" / "hidden_tests.py"
    gate_source.write_text("# changed gate\n", encoding="utf-8")
    gate_changed = build_eval_provenance(
        config=config, package_root=package_root, corpus_root=corpus
    )
    assert gate_changed.gate_sha256 != scorer_changed.gate_sha256

    changed_config = SpineConfig(arms=[baseline()], reps=6, corpus_root=corpus)
    config_changed = build_eval_provenance(
        config=changed_config, package_root=package_root, corpus_root=corpus
    )
    assert config_changed.config_sha256 != gate_changed.config_sha256
    assert config_changed.corpus_sha256 == gate_changed.corpus_sha256
    assert config_changed.code_sha256 == gate_changed.code_sha256
    assert config_changed.scorer_sha256 == gate_changed.scorer_sha256
    assert config_changed.gate_sha256 == gate_changed.gate_sha256

    (corpus / "task.json").write_text('{"name": "changed"}\n', encoding="utf-8")
    corpus_changed = build_eval_provenance(
        config=config, package_root=package_root, corpus_root=corpus
    )
    assert corpus_changed.corpus_sha256 != gate_changed.corpus_sha256
    assert corpus_changed.config_sha256 == gate_changed.config_sha256
    assert corpus_changed.code_sha256 == gate_changed.code_sha256
    assert corpus_changed.scorer_sha256 == gate_changed.scorer_sha256
    assert corpus_changed.gate_sha256 == gate_changed.gate_sha256

    answer_key = corpus / "hidden-task" / "secret-tests" / "test_hidden.py"
    answer_key.parent.mkdir(parents=True)
    (answer_key.parent.parent / "task.json").write_text(
        '{"hiddenTests":{"root":"secret-tests","files":["test_hidden.py"]}}\n',
        encoding="utf-8",
    )
    answer_key.write_text("assert True\n", encoding="utf-8")
    with_answer_key = build_eval_provenance(
        config=config, package_root=package_root, corpus_root=corpus
    )
    answer_key.write_text("assert False\n", encoding="utf-8")
    answer_key_changed = build_eval_provenance(
        config=config, package_root=package_root, corpus_root=corpus
    )
    assert answer_key_changed.answer_key_sha256 != with_answer_key.answer_key_sha256


def test_eval_cycle_requires_complete_metadata_for_promotion_grade() -> None:
    valid = EvalCycle(
        cycle_id="eval-2026-08-04-001",
        parent_cycle_id="eval-2026-08-03-004",
        hypothesis="best-of-N reduces false-green without more dollars per solve",
        changed_layers=("bestofn",),
        declared_budget_usd="25.00",
        cumulative_budget_cap_usd="75.00",
        status="proposed",
    )

    assert valid.issues() == ()
    assert valid.promotion_grade == "METADATA_COMPLETE"
    assert ("Parent cycle ID", "eval-2026-08-03-004") in valid.as_render_rows()
    assert ("Cumulative budget cap", "$75") in valid.as_render_rows()

    incomplete = EvalCycle(
        cycle_id="bad id",
        parent_cycle_id="also bad",
        hypothesis=None,
        changed_layers=(),
        declared_budget_usd="-1",
        cumulative_budget_cap_usd="75",
        status="completed",
    )

    assert incomplete.promotion_grade == "HOLD"
    assert "cycle id missing or malformed" in incomplete.issues()
    assert "status missing or invalid (expected one of: held, promoted, proposed, rejected, running)" in incomplete.issues()

    self_parent = EvalCycle(
        cycle_id="eval-2026-08-04-002",
        parent_cycle_id="eval-2026-08-04-002",
        hypothesis="verify recursion rejects a self-parented cycle",
        changed_layers=("bestofn",),
        declared_budget_usd="1",
        cumulative_budget_cap_usd="75",
        status="held",
    )
    assert "parent id must not equal cycle id" in self_parent.issues()

    rendered = EvalCycle(
        cycle_id="eval-2026-08-04-003",
        parent_cycle_id=None,
        hypothesis="measure cost | keep the report\non one row",
        changed_layers=("bestofn|objective_gate",),
        declared_budget_usd="1",
        cumulative_budget_cap_usd="75",
        status="running",
    ).as_render_rows()
    assert ("Hypothesis", "measure cost \\| keep the report on one row") in rendered
    assert ("Changed layers", "bestofn\\|objective_gate") in rendered


def test_eval_cycle_rejects_more_than_one_changed_layer_for_promotion() -> None:
    cycle = EvalCycle(
        cycle_id="eval-2026-08-04-004",
        parent_cycle_id=None,
        hypothesis="test one layer at a time",
        changed_layers=("bestofn", "objective_gate"),
        declared_budget_usd="1",
        cumulative_budget_cap_usd="3",
        status="proposed",
    )

    assert "changed layers exceed the one-layer cycle limit" in cycle.issues()

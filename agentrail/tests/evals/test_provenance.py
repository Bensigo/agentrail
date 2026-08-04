"""Tests for immutable eval-input provenance (issue #1604)."""

from pathlib import Path

from agentrail.evals.arms import baseline
from agentrail.evals.provenance import build_eval_provenance
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

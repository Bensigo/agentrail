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

    changed_config = SpineConfig(arms=[baseline()], reps=6, corpus_root=corpus)
    config_changed = build_eval_provenance(
        config=changed_config, package_root=package_root, corpus_root=corpus
    )
    assert config_changed.config_sha256 != first.config_sha256
    assert config_changed.corpus_sha256 == first.corpus_sha256
    assert config_changed.gate_sha256 == first.gate_sha256

    (corpus / "task.json").write_text('{"name": "changed"}\n', encoding="utf-8")
    corpus_changed = build_eval_provenance(
        config=config, package_root=package_root, corpus_root=corpus
    )
    assert corpus_changed.corpus_sha256 != first.corpus_sha256
    assert corpus_changed.config_sha256 == first.config_sha256

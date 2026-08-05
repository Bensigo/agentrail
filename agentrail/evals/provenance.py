"""Immutable input fingerprints for a single eval run.

The report is a decision record, not merely a rendered scorecard.  These
fingerprints identify the exact code, configuration, frozen corpus, scorer,
and gate implementation that produced it.  They deliberately use content
hashes rather than a git revision alone: a dirty checkout is still identified
honestly instead of being mistaken for its last commit.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping


@dataclass(frozen=True)
class EvalProvenance:
    """Five required content-addressed inputs for a promotable eval report."""

    code_sha256: str
    config_sha256: str
    corpus_sha256: str
    scorer_sha256: str
    gate_sha256: str

    def as_rows(self) -> tuple[tuple[str, str], ...]:
        return (
            ("Code", self.code_sha256),
            ("Config", self.config_sha256),
            ("Corpus", self.corpus_sha256),
            ("Scorer", self.scorer_sha256),
            ("Gate", self.gate_sha256),
        )


def _hash_files(files: Iterable[Path], *, relative_to: Path) -> str:
    """Hash path names and bytes in a deterministic, unambiguous stream."""
    digest = hashlib.sha256()
    for path in sorted(files, key=lambda item: item.relative_to(relative_to).as_posix()):
        relative = path.relative_to(relative_to).as_posix().encode("utf-8")
        content = path.read_bytes()
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return digest.hexdigest()


def _python_sources(root: Path) -> list[Path]:
    """All shipped Python except mutable/generated eval outputs and corpus data."""
    return [
        path
        for path in root.rglob("*.py")
        if "__pycache__" not in path.parts
        and path.relative_to(root).parts[:2] != ("evals", "reports")
        and path.relative_to(root).parts[:2] != ("evals", "corpus")
    ]


def _corpus_files(root: Path) -> list[Path]:
    return [path for path in root.rglob("*") if path.is_file() and "__pycache__" not in path.parts]


def _config_payload(config: Any) -> Mapping[str, Any]:
    """Canonical representation of the eval invocation."""
    arms = []
    for arm in config.arms:
        # ``Arm.extra_layers`` may be an immutable mappingproxy.  ``asdict``
        # deep-copies it and raises, so construct only the declared scalar
        # inputs explicitly instead of relying on a serializer with a broader
        # contract than the configuration actually has.
        arms.append(
            {
                "name": arm.name,
                "layers": asdict(arm.layers),
                "model": arm.model,
                "temperature": arm.temperature,
                "extra_layers": dict(sorted(arm.extra_layers.items())),
                "critic_model": arm.critic_model,
                "gather_model": arm.gather_model,
                "retrieval_max_tokens": arm.retrieval_max_tokens,
            }
        )
    return {
        "arms": arms,
        "reps": config.reps,
        "task_filter": list(config.task_filter) if config.task_filter is not None else None,
        "include_held_out": config.include_held_out,
        "held_out_family": config.held_out_family,
        "concurrency": config.concurrency,
        "pack_index_root": str(config.pack_index_root) if config.pack_index_root else None,
        "cost_ledger_path": str(config.cost_ledger_path) if config.cost_ledger_path else None,
    }


def build_eval_provenance(*, config: Any, package_root: Path, corpus_root: Path) -> EvalProvenance:
    """Build immutable fingerprints from the real sources used by one run."""
    package_root = package_root.resolve()
    corpus_root = corpus_root.resolve()
    config_bytes = json.dumps(
        _config_payload(config), sort_keys=True, separators=(",", ":"), default=str
    ).encode("utf-8")
    return EvalProvenance(
        code_sha256=_hash_files(_python_sources(package_root), relative_to=package_root),
        config_sha256=hashlib.sha256(config_bytes).hexdigest(),
        corpus_sha256=_hash_files(_corpus_files(corpus_root), relative_to=corpus_root),
        scorer_sha256=_hash_files(
            [package_root / "evals" / "scorer.py", package_root / "evals" / "run_record.py"],
            relative_to=package_root,
        ),
        gate_sha256=_hash_files(
            [
                package_root / "evals" / "hidden_tests.py",
                package_root / "evals" / "runner.py",
                package_root / "run" / "objective_gate.py",
            ],
            relative_to=package_root,
        ),
    )

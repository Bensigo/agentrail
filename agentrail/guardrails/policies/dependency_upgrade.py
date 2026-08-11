"""Pure dependency-upgrade evidence guardrail (#1580)."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

from agentrail.dependencies.evidence import dependency_gate_input
from agentrail.guardrails.base import Verdict
from agentrail.guardrails.registry import register


@dataclass(frozen=True)
class DependencyUpgradeEvidenceGuardrail:
    name: str = "dependency_upgrade_evidence"
    description: str = (
        "Blocks an approved dependency upgrade until candidate-bound release, usage, "
        "target-lock, peer-compatibility, and security evidence is complete. pnpm is "
        "the sole managed execution adapter. Canonical Acceptance Record external-builder "
        "evidence and Pack profiles exist for npm, Yarn Berry 4 root projects, and uv, "
        "and are external-builder-only; none grants managed execution. Python watcher "
        "candidates do not by themselves become canonical accepted evidence or Acceptance "
        "Record draft custody. Yarn has no Python watcher candidate; uv's legacy watcher "
        "candidate remains noncanonical until the external-builder boundary. Cargo and Go "
        "Modules are bounded observation-"
        "only parser foundations, excluded from evidence gates and Pack eligibility, with "
        "no managed executor. Heartbeat Go release discovery is restricted to the exact "
        "unauthenticated proxy.golang.org list path and refuses redirected response URLs. "
        "go.sum checksums are syntax-checked provided baseline "
        "material, not authenticated checksum-database or proxy receipts, and arbitrary "
        "snapshot providers do not prove repository or ambient Go configuration absence. "
        "Descriptive external-builder commands never authorize execution. Bun remains "
        "detected-only and unsupported. No live builder, deployed, or customer proof is "
        "claimed."
    )
    blocking: bool = True
    framework_neutral: bool = True

    def evaluate(self, **kwargs: object) -> Verdict:
        payload = kwargs.get("dependency_evidence")
        if not isinstance(payload, Mapping):
            return Verdict.failing("dependency evidence is missing")
        passed, detail = dependency_gate_input(payload)
        return Verdict.passing(detail) if passed else Verdict.failing(detail)


DEPENDENCY_UPGRADE_EVIDENCE = register(DependencyUpgradeEvidenceGuardrail())

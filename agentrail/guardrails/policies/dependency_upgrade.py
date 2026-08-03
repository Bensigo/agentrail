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
        "Blocks an approved pnpm upgrade until canonical release, usage, target-lock, "
        "peer-compatibility, and security evidence is complete."
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

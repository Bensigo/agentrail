"""Pure, non-factory arm inputs for frozen Acceptance Case evaluation.

This module deliberately does *not* run a coding agent. It is the contract
between a future selected-builder executor and the frozen corpus: every arm
gets exactly the material it is allowed to see, while immutable lineage binds
the evaluator's observations to a case, exact PR head, and environment.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Mapping, Optional

from .loader import ARMS, AcceptanceCase, ContextPackDescriptor


def _freeze(value: Any) -> Any:
    """Return immutable JSON-like data without retaining caller-owned objects."""
    if isinstance(value, dict):
        return MappingProxyType({str(key): _freeze(item) for key, item in value.items()})
    if isinstance(value, list):
        return tuple(_freeze(item) for item in value)
    return value


def _frozen_copy(value: Mapping[str, Any]) -> Mapping[str, Any]:
    # Round-trip first so a custom mutable mapping cannot retain a reference
    # through this eval boundary. Case JSON is the intended fixture contract.
    return _freeze(json.loads(json.dumps(value)))


@dataclass(frozen=True)
class BuilderInput:
    """Only the approved builder-visible material for one canonical arm."""

    arm: str
    user_request: str
    contract: Optional[Mapping[str, Any]] = None
    context_pack: Optional[ContextPackDescriptor] = None


@dataclass(frozen=True)
class AcceptanceLineage:
    """Evaluator-only provenance; never part of :class:`BuilderInput`."""

    case_name: str
    case_version: str
    arm: str
    contract_version: str
    repository: str
    repository_commit: str
    pr_head: str
    diff_identity: str
    environment_id: str
    context_pack_hash: Optional[str]
    context_pack_token_budget: Optional[int]


def _require_arm(arm: str) -> None:
    if arm not in ARMS:
        raise ValueError(f"unknown Acceptance Case arm: {arm}")


def _lineage_id(value: object, label: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise ValueError(f"Acceptance Case lineage requires a non-empty exact {label}")
    return value


def builder_input(case: AcceptanceCase, arm: str) -> BuilderInput:
    """Build one non-leaky input for a future external builder.

    The corpus' conversation, independent labels, source oracle, repository
    metadata, and evaluation lineage remain outside this return value. The
    executor may provision the pinned repository independently, but it must not
    treat that operational checkout as prompt/context-pack material.
    """
    _require_arm(arm)
    if arm == "agent-alone":
        return BuilderInput(arm=arm, user_request=case.user_request)
    contract = _frozen_copy(case.contract)
    if arm == "contract-only":
        return BuilderInput(arm=arm, user_request=case.user_request, contract=contract)
    return BuilderInput(
        arm=arm,
        user_request=case.user_request,
        contract=contract,
        context_pack=case.context_pack,
    )


def acceptance_lineage(
    case: AcceptanceCase,
    arm: str,
    *,
    pr_head: str,
    environment_id: str,
) -> AcceptanceLineage:
    """Bind an evaluator result to an exact frozen revision/environment pair."""
    _require_arm(arm)
    head = _lineage_id(pr_head, "PR head")
    environment = _lineage_id(environment_id, "environment id")
    revisions = [
        row
        for row in case.pr_revisions
        if isinstance(row, Mapping) and row.get("headSha") == head
    ]
    if not revisions:
        raise ValueError("PR head is not a frozen Acceptance Case revision")
    if len(revisions) != 1:
        raise ValueError("PR head is ambiguous across frozen Acceptance Case revisions")
    revision = revisions[0]
    diff_identity = _lineage_id(revision.get("diffIdentity"), "diff identity")
    if (
        sum(
            1
            for row in case.pr_revisions
            if isinstance(row, Mapping) and row.get("diffIdentity") == diff_identity
        )
        != 1
    ):
        raise ValueError("diff identity is ambiguous across frozen Acceptance Case revisions")
    environments = [
        row
        for row in case.environments
        if isinstance(row, Mapping) and row.get("id") == environment
    ]
    if not environments:
        raise ValueError("environment is not a frozen Acceptance Case environment")
    if len(environments) != 1:
        raise ValueError("environment is ambiguous across frozen Acceptance Case environments")
    includes_pack = arm in {"contract-plus-pack", "full-jace-loop"}
    return AcceptanceLineage(
        case_name=case.name,
        case_version=case.corpus_version,
        arm=arm,
        contract_version=case.contract_version,
        repository=case.repo,
        repository_commit=case.commit,
        pr_head=head,
        diff_identity=diff_identity,
        environment_id=environment,
        context_pack_hash=case.context_pack.content_hash if includes_pack else None,
        context_pack_token_budget=case.context_pack.token_budget if includes_pack else None,
    )

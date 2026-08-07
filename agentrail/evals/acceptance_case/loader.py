"""Pure loader for the trust-layer's frozen Acceptance Case corpus.

This is intentionally separate from the factory ``task.json`` corpus. A case
captures independent truth for Jace's acceptance/evidence loop, not an agent's
hidden-code-test result.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Tuple

CASE_FILE = "case.json"
ARMS = ("agent-alone", "contract-only", "contract-plus-pack", "full-jace-loop")


class AcceptanceCaseError(RuntimeError):
    pass


@dataclass(frozen=True)
class ContextPackDescriptor:
    """The bounded pack supplied only to the pack-bearing eval arms.

    This is deliberately provenance, not source custody: the frozen case keeps
    the pack hash, explicit token ceiling, and cited ranges, never raw file
    contents.  A future executor may retrieve the cited snapshot separately;
    it may not turn the eval fixture into an unbounded repository dump.
    """

    content_hash: str
    token_budget: int
    cited_source_ranges: Tuple[str, ...]


@dataclass(frozen=True)
class AcceptanceCase:
    name: str
    split: str
    corpus_version: str
    user_request: str
    conversation: List[Dict[str, Any]]
    repo: str
    commit: str
    relevant_sources: List[str]
    contract: Dict[str, Any]
    contract_version: str
    context_pack: ContextPackDescriptor
    clarification_truth: Dict[str, Any]
    pr_revisions: List[Dict[str, Any]]
    environments: List[Dict[str, Any]]
    labels: Dict[str, Any]
    source: Dict[str, Any]
    case_dir: Path


def _text(value: Any, field: str, where: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise AcceptanceCaseError(f"Acceptance Case {where}: {field} must be a non-empty string")
    return value.strip()


def _object(value: Any, field: str, where: str) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise AcceptanceCaseError(f"Acceptance Case {where}: {field} must be an object")
    return value


def _objects(value: Any, field: str, where: str) -> List[Dict[str, Any]]:
    if not isinstance(value, list) or not value or not all(isinstance(item, dict) for item in value):
        raise AcceptanceCaseError(f"Acceptance Case {where}: {field} must be a non-empty object list")
    return value


def _positive_int(value: Any, field: str, where: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise AcceptanceCaseError(f"Acceptance Case {where}: {field} must be a positive integer")
    return value


def load_case(case_dir: Path) -> AcceptanceCase:
    case_dir = Path(case_dir)
    where = repr(case_dir.name)
    try:
        raw = json.loads((case_dir / CASE_FILE).read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise AcceptanceCaseError(f"Acceptance Case {where}: missing {CASE_FILE}") from exc
    except Exception as exc:
        raise AcceptanceCaseError(f"Acceptance Case {where}: invalid {CASE_FILE}: {exc}") from exc
    if not isinstance(raw, dict):
        raise AcceptanceCaseError(f"Acceptance Case {where}: {CASE_FILE} must be an object")
    split = _text(raw.get("split"), "split", where)
    if split not in {"dev", "held-out"}:
        raise AcceptanceCaseError(f"Acceptance Case {where}: split must be dev or held-out")
    pinned = _object(raw.get("pinned"), "pinned", where)
    contract = _object(raw.get("approvedContract"), "approvedContract", where)
    contract_version = _text(contract.get("version"), "approvedContract.version", where)
    criteria = contract.get("acceptanceCriteria")
    if not isinstance(criteria, list) or not criteria:
        raise AcceptanceCaseError(f"Acceptance Case {where}: approvedContract requires acceptanceCriteria")
    revisions = _objects(raw.get("prRevisions"), "prRevisions", where)
    if any(not _text(row.get("headSha"), "prRevisions.headSha", where) or not _text(row.get("diffIdentity"), "prRevisions.diffIdentity", where) for row in revisions):
        raise AcceptanceCaseError(f"Acceptance Case {where}: each PR revision requires exact headSha and diffIdentity")
    environments = _objects(raw.get("environments"), "environments", where)
    if any(not _text(row.get("id"), "environments.id", where) or not _text(row.get("modality"), "environments.modality", where) for row in environments):
        raise AcceptanceCaseError(f"Acceptance Case {where}: each environment requires id and modality")
    labels = _object(raw.get("independentLabels"), "independentLabels", where)
    required_scores = {"contract", "context", "review", "proof", "correction", "outcome"}
    if not required_scores.issubset(labels):
        raise AcceptanceCaseError(f"Acceptance Case {where}: independentLabels must cover every trust scorecard")
    pack = _object(raw.get("contextPack"), "contextPack", where)
    allowed_pack_keys = {"contentHash", "tokenBudget", "citedSourceRanges"}
    unknown_pack_keys = set(pack) - allowed_pack_keys
    if unknown_pack_keys:
        raise AcceptanceCaseError(
            f"Acceptance Case {where}: contextPack contains unsupported custody fields: "
            f"{', '.join(sorted(unknown_pack_keys))}"
        )
    cited_source_ranges = [
        _text(item, "contextPack.citedSourceRanges item", where)
        for item in pack.get("citedSourceRanges", [])
    ]
    if not cited_source_ranges:
        raise AcceptanceCaseError(
            f"Acceptance Case {where}: contextPack requires non-empty citedSourceRanges"
        )
    return AcceptanceCase(
        name=_text(raw.get("name"), "name", where), split=split,
        corpus_version=_text(raw.get("corpusVersion"), "corpusVersion", where),
        user_request=_text(raw.get("userRequest"), "userRequest", where),
        conversation=_objects(raw.get("sourceConversation"), "sourceConversation", where),
        repo=_text(pinned.get("repo"), "pinned.repo", where), commit=_text(pinned.get("commit"), "pinned.commit", where),
        relevant_sources=[_text(item, "relevantSources item", where) for item in raw.get("relevantSources", [])],
        contract=contract,
        contract_version=contract_version,
        context_pack=ContextPackDescriptor(
            content_hash=_text(pack.get("contentHash"), "contextPack.contentHash", where),
            token_budget=_positive_int(pack.get("tokenBudget"), "contextPack.tokenBudget", where),
            cited_source_ranges=tuple(cited_source_ranges),
        ),
        clarification_truth=_object(raw.get("clarificationTruth"), "clarificationTruth", where),
        pr_revisions=revisions, environments=environments, labels=labels,
        source=_object(raw.get("source"), "source", where), case_dir=case_dir,
    )


def load_cases(root: Path, *, include_held_out: bool = False) -> List[AcceptanceCase]:
    root = Path(root)
    cases = [load_case(path) for path in sorted(root.iterdir()) if path.is_dir() and (path / CASE_FILE).is_file()]
    return cases if include_held_out else [case for case in cases if case.split == "dev"]

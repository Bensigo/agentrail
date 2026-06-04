from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Literal, Optional, Union

JsonScalar = Union[str, int, float, bool, None]
JsonValue = Union[JsonScalar, Dict[str, Any], List[Any]]

SourceType = Literal[
    "code",
    "context_doc",
    "taste_doc",
    "agent_doc",
    "memory",
    "prd",
    "milestone",
    "agentrail_state",
    "run_artifact",
    "skill",
    "external_descriptor",
]


@dataclass
class RedactionFinding:
    detector: str
    count: int

    def to_json(self) -> Dict[str, JsonValue]:
        return {"detector": self.detector, "count": self.count}


@dataclass
class Freshness:
    status: str
    observedAt: Optional[str]
    expiresAt: Optional[str]

    def to_json(self) -> Dict[str, JsonValue]:
        return asdict(self)


@dataclass
class SourceRecord:
    id: str
    sourceType: SourceType
    path: str
    contentHash: str
    modifiedAt: Optional[str]
    freshness: Freshness
    authority: str
    visibility: str
    linkedIssues: List[int]
    linkedPullRequests: List[int]
    chunkIds: List[str]
    auditRef: str
    redactions: List[RedactionFinding] = field(default_factory=list)
    content: Optional[str] = None
    memory: Optional[Dict[str, str]] = None

    def to_json(self, include_content: bool = True) -> Dict[str, JsonValue]:
        value: Dict[str, JsonValue] = {
            "id": self.id,
            "sourceType": self.sourceType,
            "path": self.path,
            "contentHash": self.contentHash,
            "modifiedAt": self.modifiedAt,
            "freshness": self.freshness.to_json(),
            "authority": self.authority,
            "visibility": self.visibility,
            "linkedIssues": self.linkedIssues,
            "linkedPullRequests": self.linkedPullRequests,
            "chunkIds": self.chunkIds,
            "auditRef": self.auditRef,
            "redactions": [finding.to_json() for finding in self.redactions],
        }
        if include_content and self.content is not None:
            value["content"] = self.content
        if self.memory is not None:
            value["memory"] = self.memory
        return value


@dataclass
class ChunkRecord:
    id: str
    sourceId: str
    sourceType: SourceType
    path: str
    language: str
    headingPath: List[str]
    parentContext: str
    startLine: Optional[int]
    endLine: Optional[int]
    symbolHints: List[str]
    importHints: List[str]
    textHash: str
    summary: Optional[str]
    citation: str
    content: str
    memory: Optional[Dict[str, str]] = None

    def to_json(self) -> Dict[str, JsonValue]:
        return {
            "id": self.id,
            "sourceId": self.sourceId,
            "sourceType": self.sourceType,
            "path": self.path,
            "language": self.language,
            "headingPath": self.headingPath,
            "parentContext": self.parentContext,
            "startLine": self.startLine,
            "endLine": self.endLine,
            "symbolHints": self.symbolHints,
            "importHints": self.importHints,
            "textHash": self.textHash,
            "summary": self.summary,
            "citation": self.citation,
            "content": self.content,
            "memory": self.memory,
        }

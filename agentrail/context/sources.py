from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List

from agentrail.context.config import ContextConfig, read_context_config
from agentrail.context.models import Freshness, RedactionFinding, SourceRecord, SourceType
from agentrail.context.redaction import redact_text
from agentrail.shared.fs import is_binary_file, matches_any, sha256_bytes, sha256_file, walk_files
from agentrail.shared.git import git_ignored_set


def utc_iso_from_timestamp(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def source_type_for(relative_path: str) -> SourceType:
    if relative_path == "CONTEXT.md" or relative_path.endswith("/CONTEXT.md"):
        return "context_doc"
    if relative_path == "TASTE.md" or relative_path.endswith("/TASTE.md"):
        return "taste_doc"
    if relative_path.startswith(("docs/agents/", "templates/docs/agents/")):
        return "agent_doc"
    if relative_path.startswith(("docs/memory/", "templates/docs/memory/")):
        return "memory"
    if relative_path.startswith(("docs/prd/", "templates/docs/prd/")):
        return "prd"
    if relative_path.startswith(("docs/milestones/", "templates/docs/milestones/")):
        return "milestone"
    if relative_path in {".agentrail/state.json", ".agentrail/config.json"}:
        return "agentrail_state"
    if relative_path.startswith((".agentrail/runs/", ".agentrail/handoffs/")):
        return "run_artifact"
    if relative_path.startswith("skills/"):
        return "skill"
    return "code"


def authority_for(source_type: SourceType, relative_path: str) -> str:
    if relative_path in {"CONTEXT.md", ".agentrail/state.json"}:
        return "critical"
    if source_type in {"taste_doc", "agent_doc", "prd", "milestone"}:
        return "high"
    if source_type == "agentrail_state":
        return "high"
    return "normal"


def linked_numbers(text: str, regex: str) -> List[int]:
    return sorted({int(match.group(1)) for match in re.finditer(regex, text)})


def linked_refs_from_text(text: str) -> Dict[str, List[int]]:
    linked_issues = set(linked_numbers(text, r"(?:^|[^A-Za-z])#(\d+)"))
    linked_issues.update(linked_numbers(text, r"/issues/(\d+)"))
    linked_prs = set(linked_numbers(text, r"/pull/(\d+)"))
    return {
        "linkedIssues": sorted(linked_issues),
        "linkedPullRequests": sorted(linked_prs),
    }


def audit_ref_for(relative_path: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9]+", "-", relative_path).strip("-").lower()
    return f"audit:source:{slug or 'root'}"


def source_record_for_file(file_path: Path, relative_path: str, *, content_hash: str | None = None, content: str | None = None, redactions: List[RedactionFinding] | None = None) -> SourceRecord:
    stats = file_path.stat()
    modified_at = utc_iso_from_timestamp(stats.st_mtime)
    source_type = source_type_for(relative_path)
    refs = linked_refs_from_text(content if content is not None else file_path.read_text(encoding="utf-8", errors="replace"))
    redacted_path = redact_text(relative_path)
    all_redactions = list(redactions or []) + redacted_path.findings
    return SourceRecord(
        id=f"source:{redacted_path.text}",
        sourceType=source_type,
        path=redacted_path.text,
        contentHash=content_hash or sha256_file(file_path),
        modifiedAt=modified_at,
        freshness=Freshness("current", modified_at, None),
        authority=authority_for(source_type, relative_path),
        visibility="redacted" if all_redactions else "local",
        linkedIssues=refs["linkedIssues"],
        linkedPullRequests=refs["linkedPullRequests"],
        chunkIds=[],
        auditRef=audit_ref_for(redacted_path.text),
        redactions=all_redactions,
        content=content,
    )


def external_record(descriptor: Dict[str, Any]) -> SourceRecord | None:
    uri = str(descriptor.get("uri") or descriptor.get("path") or descriptor.get("id") or "")
    if not uri:
        return None
    redacted_uri = redact_text(uri)
    redacted_id = redact_text(str(descriptor.get("id") or f"external:{uri}"))
    redacted = redact_text(json.dumps(descriptor, separators=(",", ":")))
    audit_ref = redact_text(str(descriptor["auditRef"])).text if descriptor.get("auditRef") else audit_ref_for(redacted_uri.text)
    all_findings = redacted.findings + redacted_uri.findings + redacted_id.findings
    return SourceRecord(
        id=redacted_id.text,
        sourceType="external_descriptor",
        path=redacted_uri.text,
        contentHash=sha256_bytes(redacted.text.encode("utf-8")),
        modifiedAt=None,
        freshness=Freshness("unknown", None, None),
        authority=str(descriptor.get("authority") or "low"),
        visibility="redacted" if all_findings else str(descriptor.get("visibility") or "metadata-only"),
        linkedIssues=[int(value) for value in descriptor.get("linkedIssues", [])] if isinstance(descriptor.get("linkedIssues"), list) else [],
        linkedPullRequests=[int(value) for value in descriptor.get("linkedPullRequests", [])] if isinstance(descriptor.get("linkedPullRequests"), list) else [],
        chunkIds=[],
        auditRef=audit_ref,
        redactions=all_findings,
        content=redacted.text,
    )


def inventory_sources(target_dir: Path, config: ContextConfig | None = None) -> List[SourceRecord]:
    root = target_dir.resolve()
    cfg = config or read_context_config(root)
    walked = walk_files(root, cfg.excludeGlobs)
    ignored = git_ignored_set(root, [file.relative_path for file in walked if not file.directory], cfg.respectGitIgnore)
    records: List[SourceRecord] = []
    for file in walked:
        if not matches_any(cfg.includeGlobs, file.relative_path):
            continue
        if matches_any(cfg.excludeGlobs, file.relative_path):
            continue
        if cfg.secretRedaction.enabled and cfg.secretRedaction.action == "exclude" and matches_any(cfg.secretRedaction.denyGlobs, file.relative_path):
            continue
        if file.relative_path in ignored:
            continue
        try:
            stats = file.full_path.stat()
        except OSError:
            continue
        if stats.st_size > cfg.maxFileSizeBytes:
            continue
        if cfg.skipBinary and is_binary_file(file.full_path):
            continue
        records.append(source_record_for_file(file.full_path, file.relative_path))
    for descriptor in cfg.externalSources:
        if isinstance(descriptor, dict):
            record = external_record(descriptor)
            if record is not None:
                records.append(record)
    records.sort(key=lambda record: (record.path, record.id))
    return records

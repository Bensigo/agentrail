from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from agentrail.context.config import ContextConfig, read_context_config
from agentrail.context.models import ChunkRecord, RedactionFinding, SourceRecord
from agentrail.context.redaction import redact_text
from agentrail.context.sources import external_record, source_record_for_file
from agentrail.shared.fs import is_binary_file, matches_any, sha256_text, walk_files
from agentrail.shared.git import git_ignored_set
from agentrail.shared.json import json_line, write_json


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def append_audit(target_dir: Path, event: Dict[str, Any]) -> None:
    audit_path = target_dir / ".agentrail" / "context" / "audit" / "events.jsonl"
    audit_path.parent.mkdir(parents=True, exist_ok=True)
    with audit_path.open("a", encoding="utf-8") as file:
        file.write(f"{json_line({'timestamp': now_iso(), **event})}\n")


def slugify(value: str) -> str:
    slug = re.sub(r"-+", "-", re.sub(r"[^a-z0-9\s-]", "", value.lower()).strip().replace(" ", "-"))
    return slug or "section"


def language_for(relative_path: str) -> str:
    ext = Path(relative_path).suffix.lower()
    name = Path(relative_path).name.lower()
    by_ext = {
        ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
        ".ts": "typescript", ".tsx": "typescript", ".py": "python", ".rb": "ruby", ".go": "go",
        ".rs": "rust", ".java": "java", ".kt": "kotlin", ".php": "php", ".cs": "csharp",
        ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp", ".sh": "shell",
        ".bash": "shell", ".zsh": "shell", ".json": "json", ".yaml": "yaml", ".yml": "yaml",
        ".toml": "toml", ".md": "markdown",
    }
    if ext in by_ext:
        return by_ext[ext]
    if name == "dockerfile":
        return "dockerfile"
    if not ext and relative_path.startswith(("scripts/", "templates/scripts/")):
        return "shell"
    return ext[1:] if ext else "text"


def cheap_import_hints(text: str) -> List[str]:
    hints: List[str] = []
    patterns = [
        re.compile(r"^\s*import\s+.+?\s+from\s+[\"'][^\"']+[\"']", re.MULTILINE),
        re.compile(r"^\s*import\s+[\"'][^\"']+[\"']", re.MULTILINE),
        re.compile(r"require\(\s*[\"'][^\"']+[\"']\s*\)"),
        re.compile(r"^\s*from\s+\S+\s+import\s+.+$", re.MULTILINE),
        re.compile(r"^\s*#include\s+[<\"].+[>\"]", re.MULTILINE),
    ]
    for pattern in patterns:
        for match in pattern.finditer(text):
            value = match.group(0).strip()
            if value not in hints:
                hints.append(value)
            if len(hints) >= 12:
                return hints
    return hints


def cheap_symbol_hints(text: str) -> List[str]:
    hints: List[str] = []
    patterns = [
        re.compile(r"\b(?:function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)"),
        re.compile(r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>"),
        re.compile(r"^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)", re.MULTILINE),
        re.compile(r"^\s*def\s+([A-Za-z_][\w]*)\s*\(", re.MULTILINE),
        re.compile(r"^\s*class\s+([A-Za-z_][\w]*)\b", re.MULTILINE),
    ]
    for pattern in patterns:
        for match in pattern.finditer(text):
            value = match.group(1)
            if value not in hints:
                hints.append(value)
            if len(hints) >= 20:
                return hints
    return hints


def parse_memory_metadata(text: str) -> Optional[Dict[str, str]]:
    fields = {"kind", "source", "confidence", "created_at", "expires_at"}
    metadata: Dict[str, str] = {}
    frontmatter = re.match(r"^---\r?\n([\s\S]*?)\r?\n---\r?\n?", text)
    if frontmatter:
        for line in frontmatter.group(1).splitlines():
            match = re.match(r"^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$", line)
            if match and match.group(1) in fields:
                metadata[match.group(1)] = match.group(2).strip("\"'")
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            for field in fields:
                if parsed.get(field) is not None:
                    metadata[field] = str(parsed[field])
    except Exception:
        pass
    return metadata or None


def chunk_record(source: SourceRecord, id_suffix: str, text: str, language: str, citation: str, start_line: Optional[int], end_line: Optional[int], *, heading_path: Optional[List[str]] = None, parent_context: str = "", symbol_hints: Optional[List[str]] = None, import_hints: Optional[List[str]] = None, memory: Optional[Dict[str, str]] = None) -> ChunkRecord:
    normalized = text.strip()
    return ChunkRecord(
        id=f"chunk:{source.path}#{id_suffix}",
        sourceId=source.id,
        sourceType=source.sourceType,
        path=source.path,
        language=language,
        headingPath=heading_path or [],
        parentContext=parent_context,
        startLine=start_line,
        endLine=end_line,
        symbolHints=symbol_hints or [],
        importHints=import_hints or [],
        textHash=sha256_text(normalized),
        summary=None,
        citation=citation,
        content=normalized,
        memory=memory,
    )


def markdown_chunks(source: SourceRecord, text: str, memory: Optional[Dict[str, str]]) -> List[ChunkRecord]:
    lines = re.split(r"\r?\n", text)
    chunks: List[ChunkRecord] = []
    stack: List[str] = []
    slug_counts: Dict[str, int] = {}
    current: Optional[Dict[str, Any]] = None

    def close_current(end_line: int) -> None:
        nonlocal current
        if current is None:
            return
        chunk_text = "\n".join(lines[int(current["startLine"]) - 1:end_line])
        chunks.append(chunk_record(source, str(current["slug"]), chunk_text, "markdown", f"{source.path}#{current['slug']}", int(current["startLine"]), end_line, heading_path=list(current["headingPath"]), parent_context=" > ".join(list(current["headingPath"])[:-1]), memory=memory))

    def add_preamble(end_line: int) -> None:
        if chunks or current is not None or end_line <= 0:
            return
        chunk_text = "\n".join(lines[:end_line])
        if not chunk_text.strip():
            return
        chunks.append(chunk_record(source, "preamble", chunk_text, "markdown", f"{source.path}#preamble", 1, end_line, parent_context=source.path, memory=memory))

    for index, line in enumerate(lines):
        match = re.match(r"^(#{1,6})\s+(.+?)\s*#*\s*$", line)
        if not match:
            continue
        level = len(match.group(1))
        title = match.group(2).strip()
        close_current(index)
        add_preamble(index)
        stack = stack[: level - 1]
        while len(stack) < level - 1:
            stack.append("")
        stack.append(title)
        heading_path = [value for value in stack if value]
        base_slug = slugify(title)
        count = slug_counts.get(base_slug, 0) + 1
        slug_counts[base_slug] = count
        current = {"startLine": index + 1, "slug": base_slug if count == 1 else f"{base_slug}-{count}", "headingPath": heading_path}
    if current is not None:
        close_current(len(lines))
    if not chunks and text.strip():
        chunks.append(chunk_record(source, "document", text, "markdown", f"{source.path}#document", 1, len(lines), parent_context=source.path, memory=memory))
    return chunks


def code_chunks(source: SourceRecord, text: str, relative_path: str) -> List[ChunkRecord]:
    lines = re.split(r"\r?\n", text)
    language = language_for(relative_path)
    imports = cheap_import_hints(text)
    symbols = cheap_symbol_hints(text)
    chunks: List[ChunkRecord] = []
    for start in range(1, len(lines) + 1, 80):
        end = min(len(lines), start + 79)
        chunk_text = "\n".join(lines[start - 1:end])
        if chunk_text.strip():
            chunks.append(chunk_record(source, f"L{start}-L{end}", chunk_text, language, f"{source.path}#L{start}-L{end}", start, end, parent_context=source.path, symbol_hints=symbols, import_hints=imports))
    return chunks


def chunks_for_source(source: SourceRecord, relative_path: str, text: str) -> List[ChunkRecord]:
    memory = parse_memory_metadata(text) if source.sourceType == "memory" else None
    if memory:
        source.memory = memory
    if language_for(relative_path) == "markdown":
        return markdown_chunks(source, text, memory)
    return code_chunks(source, text, relative_path)


def skip_event(target_dir: Path, cfg: ContextConfig, skipped_records: List[Dict[str, str]], path_value: str, reason: str) -> None:
    secret_path = cfg.secretRedaction.enabled and matches_any(cfg.secretRedaction.denyGlobs, path_value)
    if secret_path:
        redacted_path = "[REDACTED:secret_path]"
        redactions = [RedactionFinding("secret_path", 1)]
    else:
        result = redact_text(path_value)
        redacted_path = result.text
        redactions = result.findings
    event: Dict[str, Any] = {"event": "skipped_file", "path": redacted_path, "reason": reason}
    if redactions:
        event["redactions"] = [finding.to_json() for finding in redactions]
    skipped_records.append({"path": redacted_path, "reason": reason})
    append_audit(target_dir, event)


def build_index(target_dir: Path, config: ContextConfig | None = None) -> Dict[str, Any]:
    root = target_dir.resolve()
    cfg = config or read_context_config(root)
    provider_mode = cfg.embedding.mode
    summary_mode = cfg.summary.mode
    if summary_mode != "disabled" and not cfg.summary.provider:
        raise RuntimeError(f"context summary mode '{summary_mode}' requires context.summary.provider")
    if summary_mode != "disabled":
        raise RuntimeError(f"context summary mode '{summary_mode}' is not implemented; use 'disabled' for local-only indexing")

    index_dir = root / ".agentrail" / "context" / "index"
    index_dir.mkdir(parents=True, exist_ok=True)
    embedding_payload_path = index_dir / "embedding-payloads.jsonl"
    embedding_payload_path.write_text("", encoding="utf-8")

    walked = walk_files(root, cfg.excludeGlobs, include_skipped_dirs=True)
    ignored = git_ignored_set(root, [file.relative_path for file in walked if not file.directory], cfg.respectGitIgnore)
    records: List[SourceRecord] = []
    chunks: List[ChunkRecord] = []
    skipped = 0
    redaction_count = 0
    skipped_records: List[Dict[str, str]] = []

    for file in walked:
        if file.directory:
            skipped += 1
            skip_event(root, cfg, skipped_records, file.relative_path, file.skip_reason or "directory_skipped")
            continue
        reason = None
        if not matches_any(cfg.includeGlobs, file.relative_path):
            reason = "not_allowed"
        elif matches_any(cfg.excludeGlobs, file.relative_path):
            reason = "denied_path"
        elif cfg.secretRedaction.enabled and cfg.secretRedaction.action == "exclude" and matches_any(cfg.secretRedaction.denyGlobs, file.relative_path):
            reason = "secret_path"
        elif file.relative_path in ignored:
            reason = "gitignored"
        if reason:
            skipped += 1
            skip_event(root, cfg, skipped_records, file.relative_path, reason)
            continue
        try:
            stats = file.full_path.stat()
        except OSError:
            skipped += 1
            skip_event(root, cfg, skipped_records, file.relative_path, "unreadable")
            continue
        if stats.st_size > cfg.maxFileSizeBytes:
            skipped += 1
            skip_event(root, cfg, skipped_records, file.relative_path, "oversized")
            continue
        if cfg.skipBinary and is_binary_file(file.full_path):
            skipped += 1
            skip_event(root, cfg, skipped_records, file.relative_path, "binary")
            continue
        try:
            raw_text = file.full_path.read_text(encoding="utf-8")
        except Exception:
            skipped += 1
            skip_event(root, cfg, skipped_records, file.relative_path, "unreadable")
            continue
        redacted = redact_text(raw_text) if cfg.secretRedaction.enabled else None
        redacted_text = redacted.text if redacted else raw_text
        redactions = redacted.findings if redacted else []
        record = source_record_for_file(file.full_path, file.relative_path, content_hash=sha256_text(redacted_text), content=redacted_text, redactions=redactions)
        source_chunks = chunks_for_source(record, file.relative_path, redacted_text)
        record.chunkIds = [chunk.id for chunk in source_chunks]
        records.append(record)
        chunks.extend(source_chunks)
        append_audit(root, {"event": "indexed_file", "path": record.path, "contentHash": record.contentHash, "chunkCount": len(source_chunks), "redactionCount": sum(finding.count for finding in record.redactions)})
        for finding in record.redactions:
            redaction_count += finding.count
            append_audit(root, {"event": "redaction", "path": record.path, "detector": finding.detector, "action": "replace", "count": finding.count, "contentHash": record.contentHash})

    for descriptor in cfg.externalSources:
        if not isinstance(descriptor, dict):
            continue
        record = external_record(descriptor)
        if record is None:
            continue
        external_chunk = chunk_record(record, "descriptor", record.content or "", "external_descriptor", record.path, None, None, parent_context=record.path)
        record.chunkIds = [external_chunk.id]
        records.append(record)
        chunks.append(external_chunk)
        append_audit(root, {"event": "indexed_external_descriptor", "path": record.path, "contentHash": record.contentHash, "chunkCount": 1})
        for finding in record.redactions:
            redaction_count += finding.count
            append_audit(root, {"event": "redaction", "path": record.path, "detector": finding.detector, "action": "replace", "count": finding.count, "contentHash": record.contentHash})

    records.sort(key=lambda record: (record.path, record.id))
    chunks.sort(key=lambda chunk: (chunk.path, chunk.id))
    built_at = now_iso()
    index = {
        "schemaVersion": 1,
        "version": "context-index-v1",
        "builtAt": built_at,
        "provider": {"mode": provider_mode, "summary": {"mode": summary_mode, "provider": cfg.summary.provider, "model": cfg.summary.model}, "externalCalls": []},
        "records": [record.to_json(include_content=True) for record in records],
        "chunks": [chunk.to_json() for chunk in chunks],
        "skipped": skipped_records,
    }
    write_json(index_dir / "index.json", index)
    write_json(index_dir / "sources.json", [record.to_json(include_content=False) for record in records])
    append_audit(root, {"event": "external_provider_call", "mode": provider_mode, "provider": cfg.embedding.provider, "model": cfg.embedding.model, "action": "skipped_local_only" if provider_mode == "disabled" else "deferred_to_context_embed", "payloadCount": 0 if provider_mode == "disabled" else len(chunks)})
    append_audit(root, {"event": "contextual_summary", "mode": summary_mode, "provider": cfg.summary.provider, "model": cfg.summary.model, "action": "skipped_local_only" if summary_mode == "disabled" else "not_implemented", "payloadCount": 0 if summary_mode == "disabled" else len(chunks)})
    with embedding_payload_path.open("a", encoding="utf-8") as file:
        for chunk in chunks:
            file.write(f"{json_line({'mode': provider_mode, 'path': chunk.path, 'chunkId': chunk.id, 'citation': chunk.citation, 'textHash': chunk.textHash, 'sent': False, 'reason': 'local_only' if provider_mode == 'disabled' else 'deferred_to_context_embed'})}\n")
    return {
        "indexPath": ".agentrail/context/index/index.json",
        "auditPath": ".agentrail/context/audit/events.jsonl",
        "embeddingPayloadPath": ".agentrail/context/index/embedding-payloads.jsonl",
        "providerMode": provider_mode,
        "summaryMode": summary_mode,
        "indexed": len(records),
        "chunks": len(chunks),
        "skipped": skipped,
        "redactions": redaction_count,
    }


def load_index(target_dir: Path) -> Dict[str, Any]:
    return json.loads((target_dir / ".agentrail" / "context" / "index" / "index.json").read_text(encoding="utf-8"))

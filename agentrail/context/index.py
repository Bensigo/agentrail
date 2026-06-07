from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from agentrail.context.config import ContextConfig, read_context_config
from agentrail.context.models import ChunkRecord, RedactionFinding, SourceRecord
from agentrail.context.redaction import redact_text
from agentrail.context.sources import external_record, source_record_for_file
from agentrail.shared.fs import is_binary_file, matches_any, sha256_text, walk_files
from agentrail.shared.git import current_commit_sha, git_ignored_set
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


def issue_number_from_text_or_path(relative_path: str, text: str) -> Optional[int]:
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            for key in ("issue", "targetIssue"):
                if parsed.get(key) is not None:
                    return int(parsed[key])
            target = parsed.get("target")
            if isinstance(target, dict) and target.get("number") is not None:
                return int(target["number"])
    except Exception:
        pass
    for pattern in (r"source:\s*issue-(\d+)", r"(?:linked\s+)?issue\s*:?\s*#?(\d+)", r"issue[-_/](\d+)", r"issue-(\d+)", r"(?:^|[^A-Za-z])#(\d+)\b"):
        match = re.search(pattern, f"{relative_path}\n{text}", re.IGNORECASE)
        if match:
            return int(match.group(1))
    return None


def text_excerpt(text: str, *, limit: int = 260) -> str:
    compact = re.sub(r"\s+", " ", text).strip()
    return compact[:limit].rstrip() if len(compact) > limit else compact


def field_line(text: str, field: str) -> Optional[str]:
    match = re.search(rf"^\s*(?:[-*]\s*)?{re.escape(field)}\s*:\s*(.+?)\s*$", text, re.IGNORECASE | re.MULTILINE)
    if match:
        return match.group(1).strip()
    inline = re.search(rf"\b{re.escape(field)}\s*:\s*(.+?)(?:\n|$)", text, re.IGNORECASE)
    return inline.group(1).strip() if inline else None


def parsed_json_prior_mistake(relative_path: str, text: str) -> Optional[Dict[str, Any]]:
    try:
        parsed = json.loads(text)
    except Exception:
        return None
    if not isinstance(parsed, dict):
        return None
    issue = issue_number_from_text_or_path(relative_path, text)
    if relative_path.endswith("findings.json"):
        findings = parsed.get("findings")
        messages: List[str] = []
        if isinstance(findings, list):
            for finding in findings:
                if isinstance(finding, dict):
                    message = finding.get("message") or finding.get("summary") or finding.get("title")
                    if message:
                        messages.append(str(message))
                elif finding:
                    messages.append(str(finding))
        if not messages:
            return None
        return {
            "kind": "verifier-finding",
            "source": "verifier findings",
            "issue": issue,
            "status": str(parsed.get("status") or "open"),
            "whyItMatters": text_excerpt(" ".join(messages)),
            "preventionGuidance": "Review the verifier finding before retrying and include concrete verification evidence for the corrected behavior.",
        }
    blocked_reason = parsed.get("blockedReason")
    if blocked_reason:
        return {
            "kind": "blocked-run",
            "source": "blocked run reason",
            "issue": issue,
            "status": str(parsed.get("status") or "blocked"),
            "whyItMatters": text_excerpt(str(blocked_reason)),
            "preventionGuidance": "Resolve the recorded blocker or cite why it no longer applies before continuing the same workflow.",
        }
    return None


def markdown_prior_mistake(relative_path: str, source_type: str, text: str, memory: Optional[Dict[str, str]]) -> Optional[Dict[str, Any]]:
    lowered = f"{relative_path}\n{text}".lower()
    title = field_line(text, "title")
    state = field_line(text, "state") or field_line(text, "status")
    confidence = (memory or {}).get("confidence") or field_line(text, "confidence")
    kind = (memory or {}).get("kind") or field_line(text, "kind")
    source = (memory or {}).get("source") or field_line(text, "source")
    issue = issue_number_from_text_or_path(relative_path, text)
    label_line = field_line(text, "Labels") or ""
    heading_line = next((line.strip() for line in text.splitlines() if line.strip().startswith("#")), "")
    issue_marker_text = f"{relative_path}\n{heading_line}\n{label_line}".lower()
    is_review_fix = "review-fix" in issue_marker_text
    is_memory_suggestion = "memory-suggestion" in issue_marker_text
    is_failure_pattern = source_type == "memory" and (relative_path.endswith("failure-patterns.md") or str(kind).lower() == "failure-pattern")
    if not (is_review_fix or is_memory_suggestion or is_failure_pattern):
        return None
    if is_review_fix:
        mistake_kind = "review-fix"
        mistake_source = "review-fix issue"
        prevention = field_line(text, "Expected correction") or "Apply the review correction and rerun the verification named in the review-fix issue."
    elif is_memory_suggestion:
        mistake_kind = "memory-suggestion"
        mistake_source = "memory-suggestion issue"
        prevention = field_line(text, "Proposed memory") or "Check the suggested memory against current code and avoid repeating the recorded pattern."
    else:
        mistake_kind = "failure-pattern"
        mistake_source = "failure-pattern memory"
        prevention = field_line(text, "Prevention") or "Check this failure pattern before making the same kind of change."
    if re.search(r"\b(closed|resolved|done|fixed|merged)\b", str(state or ""), re.IGNORECASE):
        status = "resolved"
    elif str(confidence or "").lower() == "stale":
        status = "stale"
    else:
        status = "open"
    why = title or text_excerpt(re.sub(r"^---[\s\S]*?---", "", text).strip())
    return {
        "kind": mistake_kind,
        "source": mistake_source,
        "issue": issue,
        "status": status,
        "whyItMatters": why or "Prior mistake matched this task.",
        "preventionGuidance": prevention,
    }


def prior_mistake_for(relative_path: str, source_type: str, text: str, memory: Optional[Dict[str, str]]) -> Optional[Dict[str, Any]]:
    parsed = parsed_json_prior_mistake(relative_path, text)
    if parsed:
        return parsed
    return markdown_prior_mistake(relative_path, source_type, text, memory)


def chunk_record(source: SourceRecord, id_suffix: str, text: str, language: str, citation: str, start_line: Optional[int], end_line: Optional[int], *, heading_path: Optional[List[str]] = None, parent_context: str = "", symbol_hints: Optional[List[str]] = None, import_hints: Optional[List[str]] = None, memory: Optional[Dict[str, str]] = None, prior_mistake: Optional[Dict[str, Any]] = None, kind: Optional[str] = None, symbol: Optional[str] = None) -> ChunkRecord:
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
        kind=kind,
        symbol=symbol,
        memory=memory,
        priorMistake=prior_mistake,
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


SYMBOL_LANGUAGES = {"python", "javascript", "typescript"}

_PYTHON_SYMBOL_RE = re.compile(r"^([ \t]*)(def|class)\s+([A-Za-z_]\w*)", re.MULTILINE)
_JS_TS_SYMBOL_RE = re.compile(
    r"^([ \t]*)(?:export\s+)?(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*))",
    re.MULTILINE,
)


@dataclass
class _SymbolSpan:
    name: str
    kind: str
    start_line: int
    end_line: int
    indent: int


def _extract_python_symbols(lines: List[str]) -> List[_SymbolSpan]:
    text = "\n".join(lines)
    spans: List[_SymbolSpan] = []
    for match in _PYTHON_SYMBOL_RE.finditer(text):
        indent = len(match.group(1).expandtabs(4))
        kind_raw = match.group(2)
        name = match.group(3)
        line_number = text[:match.start()].count("\n") + 1
        kind = "class" if kind_raw == "class" else "function"
        spans.append(_SymbolSpan(name=name, kind=kind, start_line=line_number, end_line=line_number, indent=indent))
    for i, span in enumerate(spans):
        if i + 1 < len(spans):
            next_span = spans[i + 1]
            if next_span.indent <= span.indent:
                span.end_line = next_span.start_line - 1
            else:
                j = i + 1
                while j < len(spans) and spans[j].indent > span.indent:
                    j += 1
                span.end_line = (spans[j].start_line - 1) if j < len(spans) else len(lines)
        else:
            span.end_line = len(lines)
    return spans


def _extract_js_ts_symbols(lines: List[str]) -> List[_SymbolSpan]:
    text = "\n".join(lines)
    spans: List[_SymbolSpan] = []
    for match in _JS_TS_SYMBOL_RE.finditer(text):
        indent = len(match.group(1).expandtabs(4))
        name = match.group(2) or match.group(3) or ""
        kind = "class" if match.group(3) else "function"
        line_number = text[:match.start()].count("\n") + 1
        spans.append(_SymbolSpan(name=name, kind=kind, start_line=line_number, end_line=line_number, indent=indent))
    for i, span in enumerate(spans):
        span.end_line = (spans[i + 1].start_line - 1) if i + 1 < len(spans) else len(lines)
    return spans


def symbol_chunks(source: SourceRecord, text: str, relative_path: str) -> Optional[List[ChunkRecord]]:
    lines = re.split(r"\r?\n", text)
    language = language_for(relative_path)
    if language not in SYMBOL_LANGUAGES:
        return None
    try:
        if language == "python":
            spans = _extract_python_symbols(lines)
        else:
            spans = _extract_js_ts_symbols(lines)
    except Exception:
        return None
    if not spans:
        return None
    imports = cheap_import_hints(text)
    chunks: List[ChunkRecord] = []
    covered: set[int] = set()
    for span in spans:
        chunk_text = "\n".join(lines[span.start_line - 1:span.end_line])
        if not chunk_text.strip():
            continue
        for line_num in range(span.start_line, span.end_line + 1):
            covered.add(line_num)
        chunks.append(chunk_record(
            source, f"{span.kind}-{span.name}",
            chunk_text, language,
            f"{source.path}#L{span.start_line}-L{span.end_line}",
            span.start_line, span.end_line,
            parent_context=source.path,
            symbol_hints=[span.name],
            import_hints=imports,
            kind=span.kind,
            symbol=span.name,
        ))
    preamble_lines = [i for i in range(1, len(lines) + 1) if i not in covered]
    if preamble_lines:
        groups: List[List[int]] = []
        current_group: List[int] = []
        for line_num in preamble_lines:
            if current_group and line_num > current_group[-1] + 1:
                groups.append(current_group)
                current_group = [line_num]
            else:
                current_group.append(line_num)
        if current_group:
            groups.append(current_group)
        for group in groups:
            start = group[0]
            end = group[-1]
            chunk_text = "\n".join(lines[start - 1:end])
            if chunk_text.strip():
                chunks.append(chunk_record(
                    source, f"L{start}-L{end}",
                    chunk_text, language,
                    f"{source.path}#L{start}-L{end}",
                    start, end,
                    parent_context=source.path,
                    symbol_hints=cheap_symbol_hints(chunk_text),
                    import_hints=imports,
                    kind="module",
                ))
    chunks.sort(key=lambda c: c.startLine or 0)
    return chunks


def code_chunks(source: SourceRecord, text: str, relative_path: str) -> List[ChunkRecord]:
    sym_chunks = symbol_chunks(source, text, relative_path)
    if sym_chunks is not None:
        return sym_chunks
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
    source.priorMistake = None if relative_path.endswith("failure-patterns.md") else prior_mistake_for(relative_path, source.sourceType, text, memory)
    chunks = markdown_chunks(source, text, memory) if language_for(relative_path) == "markdown" else code_chunks(source, text, relative_path)
    for chunk in chunks:
        chunk.priorMistake = prior_mistake_for(relative_path, source.sourceType, chunk.content, chunk.memory or memory) or source.priorMistake
    return chunks


def skip_event(target_dir: Path, cfg: ContextConfig, skipped_records: List[Dict[str, Any]], path_value: str, reason: str) -> None:
    secret_path = cfg.secretRedaction.enabled and matches_any(cfg.secretRedaction.denyGlobs, path_value)
    if secret_path:
        redacted_path = "[REDACTED:secret_path]"
        redactions = [RedactionFinding("secret_path", 1)]
    else:
        result = redact_text(path_value)
        redacted_path = result.text
        redactions = result.findings
    source_id = f"skipped:{sha256_text(path_value)[7:23]}"
    visibility = "denied" if reason in {"denied_path", "secret_path", "exclude_glob"} else "metadata-only"
    authority = "denied" if reason in {"denied_path", "secret_path"} else "low"
    event: Dict[str, Any] = {"event": "skipped_file", "path": redacted_path, "reason": reason}
    if redactions:
        event["redactions"] = [finding.to_json() for finding in redactions]
    skipped_records.append(
        {
            "sourceId": source_id,
            "path": redacted_path,
            "reason": reason,
            "authority": authority,
            "visibility": visibility,
            "freshness": {"status": "unknown", "observedAt": None, "expiresAt": None},
            "redactions": [finding.to_json() for finding in redactions],
        }
    )
    append_audit(target_dir, event)


def graph_file_node_id(record: SourceRecord) -> str:
    return f"graph:file:{sha256_text(record.id)[7:23]}"


def graph_chunk_node_id(chunk: ChunkRecord) -> str:
    return f"graph:chunk:{sha256_text(chunk.id)[7:23]}"


def graph_codebase_unit_node_id(unit_id: str) -> str:
    return f"graph:codebase_unit:{sha256_text(unit_id)[7:23]}"


def graph_symbol_node_id(path: str, name: str, line: int) -> str:
    return f"graph:symbol:{sha256_text(f'{path}:{name}:{line}')[7:23]}"


def graph_test_node_id(path: str) -> str:
    return f"graph:test:{sha256_text(path)[7:23]}"


def normalized_unit_path(value: str) -> str:
    normalized = value.strip().strip("/")
    return normalized if normalized and normalized != "." else "."


def unit_contains_path(unit_path: str, record_path: str) -> bool:
    normalized = normalized_unit_path(unit_path)
    return normalized == "." or record_path == normalized or record_path.startswith(f"{normalized}/")


def codebase_unit(unit_id: str, name: str, path: str, detection: str, *, manifest_path: Optional[str] = None) -> Dict[str, Any]:
    unit_path = normalized_unit_path(path)
    return {
        "id": f"codebase-unit:{slugify(unit_id or unit_path or name)}",
        "name": name or unit_path,
        "path": unit_path,
        "detection": detection,
        "manifestPath": manifest_path,
        "deterministic": True,
    }


def package_workspace_patterns(root: Path) -> List[str]:
    package_json = root / "package.json"
    try:
        parsed = json.loads(package_json.read_text(encoding="utf-8"))
    except Exception:
        return []
    workspaces = parsed.get("workspaces")
    if isinstance(workspaces, dict):
        workspaces = workspaces.get("packages")
    if not isinstance(workspaces, list):
        return []
    return [str(pattern) for pattern in workspaces if isinstance(pattern, str)]


def detect_workspace_units(root: Path) -> List[Dict[str, Any]]:
    units: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for pattern in package_workspace_patterns(root):
        for path in sorted(root.glob(pattern)):
            if not path.is_dir() or not (path / "package.json").exists():
                continue
            relative = path.relative_to(root).as_posix()
            if relative in seen:
                continue
            seen.add(relative)
            units.append(codebase_unit(relative, path.name, relative, "workspace_manifest", manifest_path="package.json"))
    return units


def detect_manifest_units(root: Path, records: List[SourceRecord]) -> List[Dict[str, Any]]:
    workspace_units = detect_workspace_units(root)
    if workspace_units:
        return workspace_units
    root_manifests = {"package.json", "pyproject.toml", "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "settings.gradle"}
    record_paths = {record.path for record in records}
    manifest = next((path for path in sorted(root_manifests) if path in record_paths), None)
    if manifest:
        return [codebase_unit("root", root.name, ".", "root_manifest", manifest_path=manifest)]
    return []


def configured_codebase_units(cfg: ContextConfig) -> List[Dict[str, Any]]:
    units: List[Dict[str, Any]] = []
    for index, raw in enumerate(cfg.codebaseUnits):
        if not isinstance(raw, dict):
            continue
        path = str(raw.get("path") or raw.get("root") or ".")
        name = str(raw.get("name") or Path(path).name or "root")
        unit_id = str(raw.get("id") or name or path or f"unit-{index + 1}")
        units.append(codebase_unit(unit_id, name, path, "config_override", manifest_path=".agentrail/config.json"))
    units.sort(key=lambda unit: (unit["path"], unit["id"]))
    return units


def detect_codebase_units(root: Path, cfg: ContextConfig, records: List[SourceRecord]) -> List[Dict[str, Any]]:
    configured = configured_codebase_units(cfg)
    if configured:
        return configured
    detected = detect_manifest_units(root, records)
    if detected:
        return sorted(detected, key=lambda unit: (unit["path"], unit["id"]))
    return [codebase_unit("root", root.name, ".", "fallback")]


def extracted_symbols(text: str, relative_path: str) -> List[Dict[str, Any]]:
    language = language_for(relative_path)
    patterns: List[Tuple[str, re.Pattern[str]]] = []
    if language in {"javascript", "typescript"}:
        patterns = [
            ("function", re.compile(r"\bfunction\s+([A-Za-z_$][\w$]*)")),
            ("class", re.compile(r"\bclass\s+([A-Za-z_$][\w$]*)")),
            ("interface", re.compile(r"\binterface\s+([A-Za-z_$][\w$]*)")),
            ("type", re.compile(r"\btype\s+([A-Za-z_$][\w$]*)\s*=")),
            ("enum", re.compile(r"\benum\s+([A-Za-z_$][\w$]*)")),
            ("function", re.compile(r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>")),
        ]
    elif language == "python":
        patterns = [
            ("function", re.compile(r"^\s*def\s+([A-Za-z_][\w]*)\s*\(")),
            ("class", re.compile(r"^\s*class\s+([A-Za-z_][\w]*)\b")),
        ]
    symbols: List[Dict[str, Any]] = []
    seen: set[Tuple[str, int]] = set()
    for line_number, line in enumerate(re.split(r"\r?\n", text), start=1):
        for kind, pattern in patterns:
            match = pattern.search(line)
            if not match:
                continue
            name = match.group(1)
            key = (name, line_number)
            if key in seen:
                continue
            seen.add(key)
            symbols.append(
                {
                    "name": name,
                    "kind": kind,
                    "line": line_number,
                    "citation": f"{relative_path}#L{line_number}",
                    "deterministic": True,
                }
            )
    return symbols


def extracted_imports(text: str, relative_path: str) -> List[Dict[str, Any]]:
    language = language_for(relative_path)
    patterns: List[re.Pattern[str]] = []
    if language in {"javascript", "typescript"}:
        patterns = [
            re.compile(r"^\s*import\s+.+?\s+from\s+[\"']([^\"']+)[\"']"),
            re.compile(r"^\s*import\s+[\"']([^\"']+)[\"']"),
            re.compile(r"require\(\s*[\"']([^\"']+)[\"']\s*\)"),
        ]
    elif language == "python":
        patterns = [
            re.compile(r"^\s*from\s+([A-Za-z0-9_\.]+|\.+[A-Za-z0-9_\.]*)\s+import\s+.+$"),
            re.compile(r"^\s*import\s+([A-Za-z0-9_\.]+)"),
        ]
    imports: List[Dict[str, Any]] = []
    seen: set[Tuple[str, int]] = set()
    for line_number, line in enumerate(re.split(r"\r?\n", text), start=1):
        for pattern in patterns:
            match = pattern.search(line)
            if not match:
                continue
            specifier = match.group(1)
            key = (specifier, line_number)
            if key in seen:
                continue
            seen.add(key)
            imports.append(
                {
                    "specifier": specifier,
                    "line": line_number,
                    "citation": f"{relative_path}#L{line_number}",
                    "deterministic": True,
                }
            )
    return imports


def import_resolution_candidates(importer_path: str, specifier: str) -> List[str]:
    importer_dir = Path(importer_path).parent
    candidates: List[str] = []
    if specifier.startswith("."):
        base = (importer_dir / specifier).as_posix()
        candidates.extend(
            [
                base,
                f"{base}.js",
                f"{base}.jsx",
                f"{base}.ts",
                f"{base}.tsx",
                f"{base}.py",
                f"{base}/index.js",
                f"{base}/index.jsx",
                f"{base}/index.ts",
                f"{base}/index.tsx",
                f"{base}/__init__.py",
            ]
        )
    elif re.match(r"^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$", specifier):
        base = specifier.replace(".", "/")
        candidates.extend([f"{base}.py", f"{base}/__init__.py"])
    return [Path(candidate).as_posix().lstrip("./") for candidate in candidates]


def resolve_import_target(importer_path: str, specifier: str, record_paths: set[str]) -> Optional[str]:
    for candidate in import_resolution_candidates(importer_path, specifier):
        if candidate in record_paths:
            return candidate
    return None


def is_test_path(path: str) -> bool:
    name = Path(path).name.lower()
    parts = {part.lower() for part in Path(path).parts}
    return (
        "tests" in parts
        or "test" in parts
        or "__tests__" in parts
        or name.startswith("test_")
        or name.endswith("_test.py")
        or ".test." in name
        or ".spec." in name
    )


def source_name_candidates_for_test(path: str) -> List[str]:
    name = Path(path).name
    suffixes = "".join(Path(path).suffixes)
    stems = [name[: -len(suffixes)] if suffixes else Path(path).stem, Path(path).stem]
    candidates: set[str] = set()
    for stem in stems:
        for prefix in ("test_",):
            if stem.startswith(prefix):
                candidates.add(stem[len(prefix) :])
        for marker in ("_test", ".test", ".spec", "-test", "-spec"):
            if stem.endswith(marker):
                candidates.add(stem[: -len(marker)])
    return sorted(value for value in candidates if value)


def resolve_test_source_by_name(test_path: str, record_paths: set[str]) -> Tuple[Optional[str], List[str]]:
    candidate_names = source_name_candidates_for_test(test_path)
    suffixes = [".py", ".js", ".jsx", ".ts", ".tsx"]
    candidates: List[str] = []
    for name in candidate_names:
        for suffix in suffixes:
            for path in record_paths:
                if path == test_path or is_test_path(path):
                    continue
                if path.endswith(f"/{name}{suffix}") or path == f"{name}{suffix}":
                    candidates.append(path)
    unique = sorted(set(candidates))
    return (unique[0], unique) if len(unique) == 1 else (None, unique)


def build_code_graph(records: List[SourceRecord], chunks: List[ChunkRecord], codebase_units: List[Dict[str, Any]], built_at: str) -> Dict[str, Any]:
    nodes: List[Dict[str, Any]] = []
    edges: List[Dict[str, Any]] = []
    file_node_by_source: Dict[str, str] = {}
    file_node_by_path: Dict[str, str] = {}
    record_paths = {record.path for record in records}

    for unit in codebase_units:
        node_id = graph_codebase_unit_node_id(str(unit["id"]))
        nodes.append(
            {
                "id": node_id,
                "kind": "codebase_unit",
                "unitId": unit["id"],
                "name": unit["name"],
                "path": unit["path"],
                "detection": unit["detection"],
                "manifestPath": unit.get("manifestPath"),
                "evidence": unit["detection"],
                "deterministic": True,
            }
        )

    for record in records:
        node_id = graph_file_node_id(record)
        file_node_by_source[record.id] = node_id
        file_node_by_path[record.path] = node_id
        nodes.append(
            {
                "id": node_id,
                "kind": "file",
                "sourceId": record.id,
                "path": record.path,
                "sourceType": record.sourceType,
                "contentHash": record.contentHash,
                "freshness": record.freshness.to_json(),
                "authority": record.authority,
                "visibility": record.visibility,
                "citation": record.path,
                "evidence": "local_index_record",
                "deterministic": True,
            }
        )

    for unit in codebase_units:
        unit_node_id = graph_codebase_unit_node_id(str(unit["id"]))
        for record in records:
            file_node_id = file_node_by_path.get(record.path)
            if not file_node_id or not unit_contains_path(str(unit["path"]), record.path):
                continue
            edges.append(
                {
                    "id": f"graph:edge:{sha256_text(f'{unit_node_id}:contains_file:{file_node_id}')[7:23]}",
                    "kind": "contains_file",
                    "from": unit_node_id,
                    "to": file_node_id,
                    "unitId": unit["id"],
                    "sourceId": record.id,
                    "path": record.path,
                    "citation": record.path,
                    "evidence": unit["detection"],
                    "authority": "deterministic",
                    "deterministic": True,
                }
            )

    for record in records:
        if not record.content:
            continue
        file_node_id = file_node_by_path.get(record.path)
        if not file_node_id:
            continue
        for symbol in extracted_symbols(record.content, record.path):
            node_id = graph_symbol_node_id(record.path, str(symbol["name"]), int(symbol["line"]))
            nodes.append(
                {
                    "id": node_id,
                    "kind": "symbol",
                    "sourceId": record.id,
                    "path": record.path,
                    "name": symbol["name"],
                    "symbolKind": symbol["kind"],
                    "line": symbol["line"],
                    "citation": symbol["citation"],
                    "evidence": "deterministic_symbol_parse",
                    "deterministic": True,
                }
            )
            edges.append(
                {
                    "id": f"graph:edge:{sha256_text(f'{file_node_id}:declares_symbol:{node_id}')[7:23]}",
                    "kind": "declares_symbol",
                    "from": file_node_id,
                    "to": node_id,
                    "sourceId": record.id,
                    "path": record.path,
                    "citation": symbol["citation"],
                    "evidence": "deterministic_symbol_parse",
                    "authority": "deterministic",
                    "deterministic": True,
                }
            )
        for import_record in extracted_imports(record.content, record.path):
            target_path = resolve_import_target(record.path, str(import_record["specifier"]), record_paths)
            target_node_id = file_node_by_path.get(target_path) if target_path else None
            edge_kind = "imports_file" if target_node_id else "unresolved_import"
            edge_fingerprint = f"{file_node_id}:{edge_kind}:{import_record['specifier']}:{import_record['line']}"
            edges.append(
                {
                    "id": f"graph:edge:{sha256_text(edge_fingerprint)[7:23]}",
                    "kind": edge_kind,
                    "from": file_node_id,
                    "to": target_node_id,
                    "sourceId": record.id,
                    "path": record.path,
                    "targetPath": target_path,
                    "importSpecifier": import_record["specifier"],
                    "line": import_record["line"],
                    "citation": import_record["citation"],
                    "evidence": "deterministic_import_parse",
                    "authority": "deterministic",
                    "deterministic": True,
                }
            )

    for record in records:
        if not record.content or not is_test_path(record.path):
            continue
        file_node_id = file_node_by_path.get(record.path)
        if not file_node_id:
            continue
        test_node_id = graph_test_node_id(record.path)
        nodes.append(
            {
                "id": test_node_id,
                "kind": "test",
                "sourceId": record.id,
                "path": record.path,
                "testKind": "file",
                "citation": record.path,
                "evidence": "deterministic_test_path",
                "deterministic": True,
            }
        )
        edges.append(
            {
                "id": f"graph:edge:{sha256_text(f'{file_node_id}:classified_as_test:{test_node_id}')[7:23]}",
                "kind": "classified_as_test",
                "from": file_node_id,
                "to": test_node_id,
                "sourceId": record.id,
                "path": record.path,
                "citation": record.path,
                "evidence": "deterministic_test_path",
                "authority": "deterministic",
                "deterministic": True,
            }
        )
        linked_sources: set[str] = set()
        for import_record in extracted_imports(record.content, record.path):
            target_path = resolve_import_target(record.path, str(import_record["specifier"]), record_paths)
            target_node_id = file_node_by_path.get(target_path) if target_path and not is_test_path(target_path) else None
            if not target_path or not target_node_id:
                continue
            linked_sources.add(target_path)
            edges.append(
                {
                    "id": f"graph:edge:{sha256_text(f'{test_node_id}:tests_source:{target_node_id}:import')[7:23]}",
                    "kind": "tests_source",
                    "from": test_node_id,
                    "to": target_node_id,
                    "sourceId": record.id,
                    "path": record.path,
                    "targetPath": target_path,
                    "citation": import_record["citation"],
                    "evidence": "deterministic_test_import",
                    "authority": "deterministic",
                    "deterministic": True,
                }
            )
        target_path, candidate_paths = resolve_test_source_by_name(record.path, record_paths)
        if target_path and target_path not in linked_sources:
            target_node_id = file_node_by_path.get(target_path)
            if target_node_id:
                edges.append(
                    {
                        "id": f"graph:edge:{sha256_text(f'{test_node_id}:tests_source:{target_node_id}:path')[7:23]}",
                        "kind": "tests_source",
                        "from": test_node_id,
                        "to": target_node_id,
                        "sourceId": record.id,
                        "path": record.path,
                        "targetPath": target_path,
                        "citation": record.path,
                        "evidence": "deterministic_test_path_convention",
                        "authority": "deterministic",
                        "deterministic": True,
                    }
                )
        elif candidate_paths:
            ambiguous_edge_key = f"{test_node_id}:ambiguous_test_source:{','.join(candidate_paths)}"
            edges.append(
                {
                    "id": f"graph:edge:{sha256_text(ambiguous_edge_key)[7:23]}",
                    "kind": "unresolved_test_relationship",
                    "from": test_node_id,
                    "to": None,
                    "sourceId": record.id,
                    "path": record.path,
                    "candidateTargetPaths": candidate_paths,
                    "citation": record.path,
                    "evidence": "ambiguous_test_path_convention",
                    "authority": "unknown",
                    "deterministic": True,
                }
            )

    for chunk in chunks:
        node_id = graph_chunk_node_id(chunk)
        nodes.append(
            {
                "id": node_id,
                "kind": "chunk",
                "sourceId": chunk.sourceId,
                "path": chunk.path,
                "chunkId": chunk.id,
                "citation": chunk.citation,
                "textHash": chunk.textHash,
                "startLine": chunk.startLine,
                "endLine": chunk.endLine,
                "evidence": "local_index_chunk",
                "deterministic": True,
            }
        )
        source_node_id = file_node_by_source.get(chunk.sourceId)
        if source_node_id:
            edges.append(
                {
                    "id": f"graph:edge:{sha256_text(f'{source_node_id}:contains_chunk:{node_id}')[7:23]}",
                    "kind": "contains_chunk",
                    "from": source_node_id,
                    "to": node_id,
                    "sourceId": chunk.sourceId,
                    "path": chunk.path,
                    "citation": chunk.citation,
                    "evidence": "local_index_chunking",
                    "authority": "deterministic",
                    "deterministic": True,
                }
            )

    nodes.sort(key=lambda node: (str(node["kind"]), str(node.get("path") or ""), str(node["id"])))
    edges.sort(key=lambda edge: (str(edge["kind"]), str(edge.get("path") or ""), str(edge["id"])))
    return {
        "schemaVersion": 1,
        "version": "code-graph-v1",
        "generatedAt": built_at,
        "authority": "deterministic",
        "source": "local_indexer",
        "llmGeneratedAuthoritative": False,
        "codebaseUnits": codebase_units,
        "enrichment": {
            "status": "not_used",
            "authority": "none",
            "llmGeneratedAuthoritative": False,
        },
        "nodes": nodes,
        "edges": edges,
    }


def build_index_snapshot(root: Path, records: List[SourceRecord], graph: Dict[str, Any], built_at: str, skipped: int, redaction_count: int) -> Dict[str, Any]:
    source_hashes = {record.path: record.contentHash for record in records}
    freshness = {record.path: record.freshness.to_json() for record in records}
    ingestion_health = {
        "status": "healthy",
        "indexedCount": len(records),
        "skippedCount": skipped,
        "redactionCount": redaction_count,
        "graphNodeCount": len(graph["nodes"]),
        "graphEdgeCount": len(graph["edges"]),
    }
    return {
        "schemaVersion": 1,
        "version": "index-snapshot-v1",
        "builtAt": built_at,
        "commitSha": current_commit_sha(root),
        "sourceHashes": source_hashes,
        "freshness": freshness,
        "ingestionHealth": ingestion_health,
        "sourceCustody": {
            "mode": "metadata_only",
            "fullSourceUploadAllowed": False,
            "snippetUploadAllowed": False,
            "reason": "Default enterprise mode does not upload full source code.",
        },
    }


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
    skipped_records: List[Dict[str, Any]] = []

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
    codebase_units = detect_codebase_units(root, cfg, records)
    graph = build_code_graph(records, chunks, codebase_units, built_at)
    snapshot = build_index_snapshot(root, records, graph, built_at, skipped, redaction_count)
    index = {
        "schemaVersion": 1,
        "version": "context-index-v1",
        "builtAt": built_at,
        "snapshot": snapshot,
        "provider": {"mode": provider_mode, "summary": {"mode": summary_mode, "provider": cfg.summary.provider, "model": cfg.summary.model}, "externalCalls": []},
        "graph": graph,
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
        "commitSha": snapshot["commitSha"],
        "graphNodes": len(graph["nodes"]),
        "graphEdges": len(graph["edges"]),
        "ingestionHealth": snapshot["ingestionHealth"],
        "indexed": len(records),
        "chunks": len(chunks),
        "skipped": skipped,
        "redactions": redaction_count,
    }


def load_index(target_dir: Path) -> Dict[str, Any]:
    return json.loads((target_dir / ".agentrail" / "context" / "index" / "index.json").read_text(encoding="utf-8"))

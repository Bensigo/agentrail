from __future__ import annotations

import importlib.metadata
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from agentrail.context.config import ContextConfig, read_context_config
from agentrail.context.models import ChunkRecord, Freshness, RedactionFinding, SourceRecord
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


_LANGUAGE_TABLE: Dict[str, Dict[str, Optional[str]]] = {
    ".js":   {"language": "javascript", "grammar": "javascript"},
    ".mjs":  {"language": "javascript", "grammar": "javascript"},
    ".cjs":  {"language": "javascript", "grammar": "javascript"},
    ".jsx":  {"language": "javascript", "grammar": "javascript"},
    ".ts":   {"language": "typescript", "grammar": "typescript"},
    ".tsx":  {"language": "typescript", "grammar": "tsx"},
    ".py":   {"language": "python",     "grammar": "python"},
    ".rb":   {"language": "ruby",       "grammar": "ruby"},
    ".go":   {"language": "go",         "grammar": "go"},
    ".rs":   {"language": "rust",       "grammar": "rust"},
    ".java": {"language": "java",       "grammar": "java"},
    ".kt":   {"language": "kotlin",     "grammar": "kotlin"},
    ".php":  {"language": "php",        "grammar": "php"},
    ".cs":   {"language": "csharp",     "grammar": None},
    ".c":    {"language": "c",          "grammar": "c"},
    ".h":    {"language": "c",          "grammar": "c"},
    ".cpp":  {"language": "cpp",        "grammar": "cpp"},
    ".cc":   {"language": "cpp",        "grammar": "cpp"},
    ".hpp":  {"language": "cpp",        "grammar": "cpp"},
    ".sh":   {"language": "shell",      "grammar": "bash"},
    ".bash": {"language": "shell",      "grammar": "bash"},
    ".zsh":  {"language": "shell",      "grammar": "bash"},
    ".json": {"language": "json",       "grammar": None},
    ".yaml": {"language": "yaml",       "grammar": None},
    ".yml":  {"language": "yaml",       "grammar": None},
    ".toml": {"language": "toml",       "grammar": None},
    ".md":   {"language": "markdown",   "grammar": None},
}


def language_for(relative_path: str) -> str:
    ext = Path(relative_path).suffix.lower()
    name = Path(relative_path).name.lower()
    if ext in _LANGUAGE_TABLE:
        return _LANGUAGE_TABLE[ext]["language"]  # type: ignore[return-value]
    if name == "dockerfile":
        return "dockerfile"
    if not ext and relative_path.startswith(("scripts/", "templates/scripts/")):
        return "shell"
    return ext[1:] if ext else "text"


def grammar_for(relative_path: str) -> Optional[str]:
    ext = Path(relative_path).suffix.lower()
    entry = _LANGUAGE_TABLE.get(ext)
    return entry["grammar"] if entry else None


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


def chunk_record(source: SourceRecord, id_suffix: str, text: str, language: str, citation: str, start_line: Optional[int], end_line: Optional[int], *, heading_path: Optional[List[str]] = None, parent_context: str = "", symbol_hints: Optional[List[str]] = None, import_hints: Optional[List[str]] = None, memory: Optional[Dict[str, str]] = None, prior_mistake: Optional[Dict[str, Any]] = None) -> ChunkRecord:
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


def symbol_aware_code_chunks(source: SourceRecord, text: str, relative_path: str) -> List[ChunkRecord]:
    """Produce one chunk per parsed symbol (function/class/method).

    End line is inferred as next_symbol_start - 1, or EOF for the last symbol.
    Lines before the first symbol are emitted as a preamble chunk when non-empty.
    Falls back to line-window chunks (code_chunks) for unsupported languages,
    empty symbol tables, or parser failures.
    """
    try:
        symbols = extracted_symbols(text, relative_path)
    except Exception:
        symbols = []

    if not symbols:
        return code_chunks(source, text, relative_path)

    lines = re.split(r"\r?\n", text)
    language = language_for(relative_path)
    imports = cheap_import_hints(text)
    chunks: List[ChunkRecord] = []

    # Preamble: lines before the first symbol (e.g. imports, module docstring)
    first_sym_line = symbols[0]["line"]
    if first_sym_line > 1:
        preamble_text = "\n".join(lines[:first_sym_line - 1])
        if preamble_text.strip():
            chunks.append(chunk_record(
                source,
                "preamble",
                preamble_text,
                language,
                f"{source.path}#preamble",
                1,
                first_sym_line - 1,
                parent_context=source.path,
                import_hints=imports,
            ))

    for i, sym in enumerate(symbols):
        start_line = sym["line"]
        end_line = symbols[i + 1]["line"] - 1 if i + 1 < len(symbols) else len(lines)
        chunk_text = "\n".join(lines[start_line - 1:end_line])
        if not chunk_text.strip():
            continue
        sym_name = str(sym["name"])
        sym_kind = str(sym["kind"])
        # Use name:line as ID suffix to handle duplicate names at different positions
        cr = chunk_record(
            source,
            f"symbol:{sym_name}:{start_line}",
            chunk_text,
            language,
            f"{source.path}#{sym_name}",
            start_line,
            end_line,
            parent_context=source.path,
            symbol_hints=[sym_name],
            import_hints=imports,
        )
        cr.symbol = sym_name
        cr.kind = sym_kind
        chunks.append(cr)

    return chunks if chunks else code_chunks(source, text, relative_path)


def chunks_for_source(source: SourceRecord, relative_path: str, text: str) -> List[ChunkRecord]:
    memory = parse_memory_metadata(text) if source.sourceType == "memory" else None
    if memory:
        source.memory = memory
    source.priorMistake = None if relative_path.endswith("failure-patterns.md") else prior_mistake_for(relative_path, source.sourceType, text, memory)
    chunks = markdown_chunks(source, text, memory) if language_for(relative_path) == "markdown" else symbol_aware_code_chunks(source, text, relative_path)
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


def _regex_symbols(text: str, relative_path: str) -> List[Dict[str, Any]]:
    """Regex-based symbol extraction (fallback path).

    Each returned dict includes ``parsedBy: "regex_fallback"``.
    """
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
            symbols.append({
                "name": name,
                "kind": kind,
                "line": line_number,
                "lineEnd": line_number,
                "citation": f"{relative_path}#L{line_number}",
                "deterministic": True,
                "parsedBy": "regex_fallback",
            })
    return symbols


def _ast_symbols_from_root(
    root_node: Any, relative_path: str, grammar_name: str
) -> List[Dict[str, Any]]:
    """Walk a tree-sitter AST root and return symbol definition dicts.

    Output schema: ``{name, kind, line, citation, deterministic}`` — no ``parsedBy`` field.
    """
    symbols: List[Dict[str, Any]] = []

    def _sym(name: str, kind: str, node: Any) -> Dict[str, Any]:
        line = node.start_point[0] + 1
        line_end = node.end_point[0] + 1
        return {
            "name": name,
            "kind": kind,
            "line": line,
            "lineEnd": line_end,
            "citation": f"{relative_path}#L{line}",
            "deterministic": True,
        }

    def _name(node: Any) -> Optional[str]:
        n = node.child_by_field_name("name")
        return n.text.decode("utf-8", errors="replace") if n is not None else None

    def _kotlin_name(node: Any) -> Optional[str]:
        for child in node.children:
            if child.type in ("simple_identifier", "type_identifier"):
                return child.text.decode("utf-8", errors="replace")
        return None

    def _c_func_name(node: Any) -> Optional[str]:
        def _find_id(n: Any) -> Optional[str]:
            if n.type == "identifier":
                return n.text.decode("utf-8", errors="replace")
            for c in n.children:
                r = _find_id(c)
                if r:
                    return r
            return None
        for child in node.children:
            if "declarator" in child.type:
                return _find_id(child)
        return None

    def _js_arrow_name(node: Any) -> Optional[str]:
        for child in node.children:
            if child.type != "variable_declarator":
                continue
            name_node = child.child_by_field_name("name")
            if name_node is None:
                for cc in child.children:
                    if cc.type == "identifier":
                        name_node = cc
                        break
            value_node = child.child_by_field_name("value")
            if value_node is None:
                for cc in child.children:
                    if cc.type in ("arrow_function", "function_expression", "generator_function_expression"):
                        value_node = cc
                        break
            if name_node and value_node:
                return name_node.text.decode("utf-8", errors="replace")
        return None

    def _go_type_sym(node: Any) -> Optional[Dict[str, Any]]:
        for child in node.children:
            if child.type == "type_spec":
                name_node: Any = None
                kind = "type"
                for cc in child.children:
                    if cc.type == "type_identifier" and name_node is None:
                        name_node = cc
                    elif cc.type == "struct_type":
                        kind = "struct"
                    elif cc.type == "interface_type":
                        kind = "interface"
                if name_node:
                    return _sym(name_node.text.decode("utf-8", errors="replace"), kind, node)
            elif child.type == "type_alias":
                name_node = child.child_by_field_name("name")
                if name_node is None:
                    for cc in child.children:
                        if cc.type == "type_identifier":
                            name_node = cc
                            break
                if name_node:
                    return _sym(name_node.text.decode("utf-8", errors="replace"), "type", node)
        return None

    def _body(node: Any, *fallback_types: str) -> Optional[Any]:
        b = node.child_by_field_name("body")
        if b is not None:
            return b
        for child in node.children:
            if child.type in fallback_types:
                return child
        return None

    def walk(nodes: Any, in_class: bool = False) -> None:
        for node in nodes:
            if not node.is_named:
                continue
            t = node.type

            if grammar_name == "python":
                if t == "decorated_definition":
                    inner = node.child_by_field_name("definition")
                    if inner is not None:
                        walk([inner], in_class)
                elif t == "function_definition":
                    nm = _name(node)
                    if nm:
                        symbols.append(_sym(nm, "method" if in_class else "function", node))
                elif t == "class_definition":
                    nm = _name(node)
                    if nm:
                        symbols.append(_sym(nm, "class", node))
                        if not in_class:
                            body = _body(node, "block", "suite")
                            if body:
                                walk(body.children, in_class=True)

            elif grammar_name in ("javascript", "typescript", "tsx"):
                if t == "export_statement":
                    # Unwrap: `export function foo()`, `export class Foo {}`, etc.
                    decl = node.child_by_field_name("declaration")
                    if decl is not None:
                        walk([decl], in_class)
                    else:
                        walk(node.children, in_class)
                elif t == "function_declaration":
                    nm = _name(node)
                    if nm:
                        symbols.append(_sym(nm, "method" if in_class else "function", node))
                elif t == "class_declaration":
                    nm = _name(node)
                    if nm:
                        symbols.append(_sym(nm, "class", node))
                        if not in_class:
                            body = _body(node, "class_body")
                            if body:
                                walk(body.children, in_class=True)
                elif t in ("interface_declaration", "enum_declaration"):
                    nm = _name(node)
                    if nm:
                        symbols.append(_sym(nm, t.split("_")[0], node))
                elif t == "type_alias_declaration":
                    nm = _name(node)
                    if nm:
                        symbols.append(_sym(nm, "type", node))
                elif t == "lexical_declaration" and not in_class:
                    nm = _js_arrow_name(node)
                    if nm:
                        symbols.append(_sym(nm, "function", node))
                elif t == "method_definition" and in_class:
                    nm = _name(node)
                    if nm:
                        symbols.append(_sym(nm, "method", node))

            elif grammar_name == "go":
                if t == "function_declaration":
                    nm = _name(node)
                    if nm:
                        symbols.append(_sym(nm, "function", node))
                elif t == "method_declaration":
                    nm = _name(node)
                    if nm:
                        symbols.append(_sym(nm, "method", node))
                elif t == "type_declaration":
                    s = _go_type_sym(node)
                    if s:
                        symbols.append(s)

            elif grammar_name == "rust":
                if t == "function_item":
                    nm = _name(node)
                    if nm:
                        symbols.append(_sym(nm, "method" if in_class else "function", node))
                elif t == "struct_item":
                    nm = _name(node)
                    if nm:
                        symbols.append(_sym(nm, "struct", node))
                elif t == "enum_item":
                    nm = _name(node)
                    if nm:
                        symbols.append(_sym(nm, "enum", node))
                elif t == "type_item":
                    nm = _name(node)
                    if nm:
                        symbols.append(_sym(nm, "type", node))
                elif t == "impl_item":
                    body = _body(node, "declaration_list")
                    if body:
                        walk(body.children, in_class=True)

            elif grammar_name == "java":
                if t == "class_declaration":
                    nm = _name(node)
                    if nm:
                        symbols.append(_sym(nm, "class", node))
                        if not in_class:
                            body = _body(node, "class_body")
                            if body:
                                walk(body.children, in_class=True)
                elif t == "interface_declaration":
                    nm = _name(node)
                    if nm:
                        symbols.append(_sym(nm, "interface", node))
                elif t == "enum_declaration":
                    nm = _name(node)
                    if nm:
                        symbols.append(_sym(nm, "enum", node))
                elif t == "method_declaration" and in_class:
                    nm = _name(node)
                    if nm:
                        symbols.append(_sym(nm, "method", node))

            elif grammar_name == "kotlin":
                if t == "function_declaration":
                    nm = _kotlin_name(node)
                    if nm:
                        symbols.append(_sym(nm, "method" if in_class else "function", node))
                elif t in ("class_declaration", "object_declaration"):
                    nm = _kotlin_name(node)
                    if nm:
                        symbols.append(_sym(nm, "class", node))
                        if not in_class:
                            body = _body(node, "class_body")
                            if body:
                                walk(body.children, in_class=True)

            elif grammar_name == "ruby":
                if t == "method":
                    nm = _name(node)
                    if nm:
                        symbols.append(_sym(nm, "method" if in_class else "function", node))
                elif t in ("class", "module"):
                    nm = _name(node)
                    if nm:
                        symbols.append(_sym(nm, "class", node))
                        if not in_class:
                            body = _body(node, "body_statement")
                            if body:
                                walk(body.children, in_class=True)

            elif grammar_name == "php":
                if t == "function_definition":
                    nm = _name(node)
                    if nm:
                        symbols.append(_sym(nm, "method" if in_class else "function", node))
                elif t == "class_declaration":
                    nm = _name(node)
                    if nm:
                        symbols.append(_sym(nm, "class", node))
                        if not in_class:
                            body = _body(node, "declaration_list")
                            if body:
                                walk(body.children, in_class=True)
                elif t == "method_declaration" and in_class:
                    nm = _name(node)
                    if nm:
                        symbols.append(_sym(nm, "method", node))

            elif grammar_name in ("c", "cpp"):
                if t == "function_definition":
                    nm = _c_func_name(node)
                    if nm:
                        symbols.append(_sym(nm, "method" if in_class else "function", node))
                elif t == "declaration":
                    # Function prototype (header file declaration, no body)
                    has_func_decl = any("declarator" in c.type for c in node.children)
                    if has_func_decl:
                        nm = _c_func_name(node)
                        if nm:
                            symbols.append(_sym(nm, "method" if in_class else "function", node))
                elif t == "struct_specifier":
                    nm = _name(node)
                    if nm:
                        symbols.append(_sym(nm, "struct", node))
                elif t == "class_specifier" and grammar_name == "cpp":
                    nm = _name(node)
                    if nm:
                        symbols.append(_sym(nm, "class", node))
                        if not in_class:
                            body = _body(node, "field_declaration_list")
                            if body:
                                walk(body.children, in_class=True)

            elif grammar_name == "bash":
                if t == "function_definition":
                    nm = _name(node)
                    if nm:
                        symbols.append(_sym(nm, "function", node))

    walk(root_node.children)
    return symbols


def extracted_symbols(text: str, relative_path: str) -> List[Dict[str, Any]]:
    """Extract top-level symbol definitions from source text.

    Uses tree-sitter AST for supported languages (grammar_for returns non-None).
    Falls back to regex for unsupported extensions, parse errors, or zero symbols
    with parse errors. Fallback symbols include ``parsedBy: "regex_fallback"``.
    Schema: ``{name, kind, line, citation, deterministic}``; tree-sitter path omits
    ``parsedBy``; fallback path adds it.
    """
    grammar = grammar_for(relative_path)
    if grammar is None:
        return _regex_symbols(text, relative_path)
    root_node = None
    try:
        import tree_sitter_language_pack  # noqa: PLC0415
        parser = tree_sitter_language_pack.get_parser(grammar)
        tree = parser.parse(text.encode("utf-8", errors="replace"))
        root_node = tree.root_node
        symbols = _ast_symbols_from_root(root_node, relative_path, grammar)
    except Exception:
        return _regex_symbols(text, relative_path)
    if not symbols and root_node is not None and root_node.has_error:
        return _regex_symbols(text, relative_path)
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
    elif re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", specifier):
        # Single-segment bare module name: try in importer's directory first, then root.
        # Handles `import helpers` when helpers.py is co-located or at repo root.
        dir_pos = importer_dir.as_posix()
        if dir_pos and dir_pos != ".":
            candidates.extend([
                f"{dir_pos}/{specifier}.py",
                f"{dir_pos}/{specifier}/__init__.py",
            ])
        candidates.extend([f"{specifier}.py", f"{specifier}/__init__.py"])
    return [Path(candidate).as_posix().lstrip("./") for candidate in candidates]


def resolve_import_target(importer_path: str, specifier: str, record_paths: set[str]) -> Optional[str]:
    for candidate in import_resolution_candidates(importer_path, specifier):
        if candidate in record_paths:
            return candidate
    return None


def _python_name_imports(text: str) -> Dict[str, str]:
    """Parse ``from X import Y [as Z], ...`` and return ``{callable_name: specifier}``.

    Used for call resolution when the callee name has no module prefix (e.g.
    ``from pkg.utils import helper; helper()``).
    """
    result: Dict[str, str] = {}
    pattern = re.compile(
        r"^\s*from\s+([A-Za-z0-9_\.]+|\.+[A-Za-z0-9_\.]*)\s+import\s+(.+)$",
        re.MULTILINE,
    )
    for match in pattern.finditer(text):
        specifier = match.group(1)
        names_str = match.group(2).strip().strip("()")
        for part in names_str.split(","):
            part = part.strip()
            if not part:
                continue
            if " as " in part:
                _orig, alias = part.split(" as ", 1)
                alias = alias.strip()
            else:
                alias = part.strip()
            if re.match(r"^[A-Za-z_]\w*$", alias):
                result.setdefault(alias, specifier)
    return result


def _ts_named_imports(text: str) -> Dict[str, str]:
    """Parse TypeScript/JavaScript named and default imports.

    Handles:
    - ``import { foo [as bar], baz } from './mod'``
    - ``import DefaultExport from './mod'``

    Returns ``{imported_name: specifier}``.
    """
    result: Dict[str, str] = {}
    # Named imports: import { foo, bar as b } from './mod'
    named = re.compile(
        r"import\s*\{([^}]+)\}\s*from\s*[\"']([^\"']+)[\"']", re.MULTILINE
    )
    for match in named.finditer(text):
        specifier = match.group(2)
        for part in match.group(1).split(","):
            part = part.strip()
            if not part:
                continue
            if " as " in part:
                _orig, alias = part.split(" as ", 1)
                alias = alias.strip()
            else:
                alias = part.strip()
            if re.match(r"^[A-Za-z_$][\w$]*$", alias):
                result.setdefault(alias, specifier)
    # Default import: import Foo from './mod'
    default = re.compile(
        r"import\s+([A-Za-z_$][\w$]*)\s+from\s*[\"']([^\"']+)[\"']"
    )
    for match in default.finditer(text):
        name = match.group(1)
        if name in ("type", "interface"):
            continue
        result.setdefault(name, match.group(2))
    return result


def _ast_calls_from_root(
    root_node: Any, relative_path: str, grammar_name: str
) -> List[Dict[str, Any]]:
    """Walk an AST root and return call expression dicts for each function body.

    Each dict has:
        callerName (str), callerLine (int), callee (str|None),
        calleeModule (str|None), callLine (int), dynamic (bool)

    Supports Python, JavaScript, TypeScript, and TSX.
    Nested function definitions are not descended into (they are separate symbols).
    """
    calls: List[Dict[str, Any]] = []

    # Node types that end the scope of a caller (nested callables)
    if grammar_name == "python":
        _SKIP_TYPES: set[str] = {"function_definition", "class_definition", "decorated_definition"}
        _CALL_TYPE = "call"
    elif grammar_name in ("javascript", "typescript", "tsx"):
        _SKIP_TYPES = {
            "function_declaration",
            "function_expression",
            "arrow_function",
            "method_definition",
            "class_declaration",
        }
        _CALL_TYPE = "call_expression"
    else:
        return []

    def _callee_info(func_node: Any) -> Tuple[Optional[str], Optional[str], bool]:
        """Return (callee_name, module_name, is_dynamic)."""
        if grammar_name == "python":
            if func_node.type == "identifier":
                return func_node.text.decode("utf-8", errors="replace"), None, False
            if func_node.type == "attribute":
                obj = func_node.child_by_field_name("object")
                attr = func_node.child_by_field_name("attribute")
                if obj is not None and attr is not None and obj.type == "identifier":
                    return (
                        attr.text.decode("utf-8", errors="replace"),
                        obj.text.decode("utf-8", errors="replace"),
                        False,
                    )
            return None, None, True
        else:  # javascript / typescript / tsx
            if func_node.type == "identifier":
                return func_node.text.decode("utf-8", errors="replace"), None, False
            if func_node.type == "member_expression":
                obj = func_node.child_by_field_name("object")
                prop = func_node.child_by_field_name("property")
                if obj is not None and prop is not None and obj.type == "identifier":
                    return (
                        prop.text.decode("utf-8", errors="replace"),
                        obj.text.decode("utf-8", errors="replace"),
                        False,
                    )
            return None, None, True

    def _walk_body(body_node: Any, caller_name: str, caller_line: int) -> None:
        """DFS walk of body_node, recording call expressions (not crossing scope)."""
        if body_node is None:
            return
        for child in body_node.children:
            if not child.is_named:
                continue
            if child.type == _CALL_TYPE:
                func_node = child.child_by_field_name("function")
                if func_node is not None:
                    callee, module, is_dynamic = _callee_info(func_node)
                    calls.append({
                        "callerName": caller_name,
                        "callerLine": caller_line,
                        "callee": callee,
                        "calleeModule": module,
                        "callLine": child.start_point[0] + 1,
                        "dynamic": is_dynamic,
                    })
                # Recurse into call node to find nested calls (e.g. foo(bar()))
                _walk_body(child, caller_name, caller_line)
            elif child.type not in _SKIP_TYPES:
                _walk_body(child, caller_name, caller_line)

    def _get_name(node: Any) -> Optional[str]:
        n = node.child_by_field_name("name")
        return n.text.decode("utf-8", errors="replace") if n is not None else None

    def _walk_top(nodes: Any) -> None:
        for node in nodes:
            if not node.is_named:
                continue
            t = node.type

            if grammar_name == "python":
                if t == "decorated_definition":
                    inner = node.child_by_field_name("definition")
                    if inner is not None:
                        _walk_top([inner])
                elif t == "function_definition":
                    name = _get_name(node)
                    if name:
                        body = node.child_by_field_name("body")
                        _walk_body(body, name, node.start_point[0] + 1)
                elif t == "class_definition":
                    body = node.child_by_field_name("body")
                    if body:
                        _walk_top(body.children)

            elif grammar_name in ("javascript", "typescript", "tsx"):
                if t == "export_statement":
                    # Unwrap: `export function foo()`, `export const foo = () => {}`
                    decl = node.child_by_field_name("declaration")
                    if decl is not None:
                        _walk_top([decl])
                    else:
                        _walk_top(node.children)
                elif t == "function_declaration":
                    name = _get_name(node)
                    if name:
                        body = node.child_by_field_name("body")
                        _walk_body(body, name, node.start_point[0] + 1)
                elif t == "class_declaration":
                    body = node.child_by_field_name("body")
                    if body:
                        _walk_top(body.children)
                elif t == "method_definition":
                    name = _get_name(node)
                    if name:
                        body = node.child_by_field_name("body")
                        _walk_body(body, name, node.start_point[0] + 1)
                elif t == "lexical_declaration":
                    # Arrow function or function expression assigned to a const/let
                    for child in node.children:
                        if child.type != "variable_declarator":
                            continue
                        name_node = child.child_by_field_name("name")
                        value_node = child.child_by_field_name("value")
                        if value_node is None:
                            for cc in child.children:
                                if cc.type in ("arrow_function", "function_expression"):
                                    value_node = cc
                                    break
                        if name_node and value_node:
                            fn_name = name_node.text.decode("utf-8", errors="replace")
                            body = value_node.child_by_field_name("body")
                            if body is not None:
                                _walk_body(body, fn_name, node.start_point[0] + 1)

    _walk_top(root_node.children)
    return calls


def extracted_calls(text: str, relative_path: str) -> List[Dict[str, Any]]:
    """Extract call expressions from function/method bodies using the tree-sitter AST.

    Returns a list of dicts with keys:
        ``callerName`` (str) — name of the containing function/method
        ``callerLine`` (int) — 1-based line of the caller definition
        ``callee`` (str|None) — name of the called function (None when dynamic)
        ``calleeModule`` (str|None) — object/module prefix if qualified (e.g. ``os``)
        ``callLine`` (int) — 1-based line of the call expression
        ``dynamic`` (bool) — True for computed/anonymous call targets

    Only Python, JavaScript, TypeScript, and TSX are supported.
    Returns an empty list for unsupported grammars or on parse errors.
    """
    grammar = grammar_for(relative_path)
    if grammar not in ("python", "javascript", "typescript", "tsx"):
        return []
    try:
        import tree_sitter_language_pack  # noqa: PLC0415
        parser = tree_sitter_language_pack.get_parser(grammar)
        tree = parser.parse(text.encode("utf-8", errors="replace"))
        root_node = tree.root_node
    except Exception:
        return []
    try:
        return _ast_calls_from_root(root_node, relative_path, grammar)
    except Exception:
        return []


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

    # Build symbol node lookup for call resolution: {path: {name: node_id}}.
    # Reuses already-emitted symbol nodes to avoid re-calling extracted_symbols.
    _symbol_node_lookup: Dict[str, Dict[str, str]] = {}
    for _node in nodes:
        if _node.get("kind") == "symbol":
            _sp = str(_node.get("path", ""))
            _sn = str(_node.get("name", ""))
            _snid = str(_node.get("id", ""))
            if _sp and _sn and _snid:
                _symbol_node_lookup.setdefault(_sp, {}).setdefault(_sn, _snid)

    _denied_paths = {rec.path for rec in records if rec.authority == "denied"}

    for record in records:
        if record.authority == "denied" or not record.content:
            continue
        file_node_id = file_node_by_path.get(record.path)
        if not file_node_id:
            continue

        _call_list = extracted_calls(record.content, record.path)
        if not _call_list:
            continue

        _language = language_for(record.path)
        # Module-alias → specifier (for `import module` or `import pkg.module` style)
        _module_imports: Dict[str, str] = {}
        for _imp in extracted_imports(record.content, record.path):
            _spec = str(_imp["specifier"])
            if not _spec.startswith("."):
                _last = _spec.split(".")[-1]
                _module_imports.setdefault(_last, _spec)

        # Name → specifier (for `from X import name` / TS `import { name } from X`)
        _name_imports: Dict[str, str] = {}
        if _language == "python":
            _name_imports = _python_name_imports(record.content)
        elif _language in ("javascript", "typescript"):
            _name_imports = _ts_named_imports(record.content)

        _local_syms = _symbol_node_lookup.get(record.path, {})

        for _call in _call_list:
            _caller_name = str(_call["callerName"])
            _call_line = int(_call["callLine"])
            _is_dynamic = bool(_call["dynamic"])
            _callee: Optional[str] = _call.get("callee")
            _callee_mod: Optional[str] = _call.get("calleeModule")

            # Caller must be in the symbol table (only index known symbols)
            _caller_nid = _local_syms.get(_caller_name)
            if _caller_nid is None:
                continue

            if _is_dynamic or not _callee:
                _fp = f"{_caller_nid}:calls:dynamic:{_call_line}"
                edges.append({
                    "id": f"graph:edge:{sha256_text(_fp)[7:23]}",
                    "kind": "calls",
                    "from": _caller_nid,
                    "to": None,
                    "callerPath": record.path,
                    "callerLine": _call_line,
                    "resolved": False,
                    "unresolvedReason": "dynamic_call",
                    "evidence": "deterministic_call_parse",
                    "authority": "deterministic",
                    "deterministic": True,
                })
                continue

            _target_path: Optional[str] = None
            _callee_nid: Optional[str] = None
            _unresolved: Optional[str] = None

            if _callee_mod:
                # Qualified call: module.func()
                _specifier = _module_imports.get(_callee_mod) or _name_imports.get(_callee_mod)
                if _specifier is None:
                    _unresolved = "no_import"
                else:
                    _target_path = resolve_import_target(record.path, _specifier, record_paths)
                    if _target_path is None:
                        _unresolved = "external_module"
                    elif _target_path in _denied_paths:
                        continue  # AC4: never emit edges to denied targets
                    else:
                        _callee_nid = _symbol_node_lookup.get(_target_path, {}).get(_callee)
                        if _callee_nid is None:
                            _unresolved = "no_import"
            else:
                # Unqualified call: check local symbols first, then name imports
                _local_nid = _local_syms.get(_callee)
                if _local_nid:
                    _callee_nid = _local_nid
                    _target_path = record.path
                else:
                    _specifier = _name_imports.get(_callee)
                    if _specifier is None:
                        _unresolved = "no_import"
                    else:
                        _target_path = resolve_import_target(record.path, _specifier, record_paths)
                        if _target_path is None:
                            _unresolved = "external_module"
                        elif _target_path in _denied_paths:
                            continue  # AC4
                        else:
                            _callee_nid = _symbol_node_lookup.get(_target_path, {}).get(_callee)
                            if _callee_nid is None:
                                _unresolved = "no_import"

            if _callee_nid is not None:
                _fp = f"{_caller_nid}:calls:{_callee_nid}:{_call_line}"
                edges.append({
                    "id": f"graph:edge:{sha256_text(_fp)[7:23]}",
                    "kind": "calls",
                    "from": _caller_nid,
                    "to": _callee_nid,
                    "callerPath": record.path,
                    "callerLine": _call_line,
                    "calleePath": _target_path,
                    "calleeSymbol": _callee,
                    "resolved": True,
                    "evidence": "deterministic_call_parse",
                    "authority": "deterministic",
                    "deterministic": True,
                })
            else:
                _fp = f"{_caller_nid}:calls:unresolved:{_callee or 'unknown'}:{_call_line}"
                edges.append({
                    "id": f"graph:edge:{sha256_text(_fp)[7:23]}",
                    "kind": "calls",
                    "from": _caller_nid,
                    "to": None,
                    "callerPath": record.path,
                    "callerLine": _call_line,
                    "callee": _callee,
                    "resolved": False,
                    "unresolvedReason": _unresolved or "no_import",
                    "evidence": "deterministic_call_parse",
                    "authority": "deterministic",
                    "deterministic": True,
                })

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


def _parser_versions() -> Dict[str, str]:
    """Return a dict mapping each non-None grammar in _LANGUAGE_TABLE to its installed version.

    All grammars come from tree-sitter-language-pack, so they share one version string.
    Falls back to "unknown" if the package is not importable.
    """
    try:
        pack_version = importlib.metadata.version("tree-sitter-language-pack")
    except Exception:
        pack_version = "unknown"
    grammars = sorted({v["grammar"] for v in _LANGUAGE_TABLE.values() if v["grammar"] is not None})
    return {grammar: pack_version for grammar in grammars}


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
        "parserVersions": _parser_versions(),
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


_BUILD_INDEX_STALENESS_SECONDS = 120


def _source_tree_fingerprint(walked: List[Any]) -> str:
    """Stable hash of the indexed file set (paths only) to detect add/remove/rename."""
    paths = sorted(entry.relative_path for entry in walked if not entry.directory)
    return sha256_text("\n".join(paths))


def _indexable_entries(root: Path, cfg: ContextConfig) -> List[Any]:
    """The glob-filtered file set the freshness fingerprint is built from.

    Both the write side (build_index → freshness.json) and the check side
    (_cached_index_is_fresh) MUST derive the fingerprint from this exact set.
    Deriving the write side from post-skip records (which also drop binary,
    gitignored, and oversized files) makes the fingerprints permanently
    disagree on any real repo — a permanent cache miss.
    """
    walked = walk_files(root, cfg.excludeGlobs)
    return [
        entry for entry in walked
        if not entry.directory
        and matches_any(cfg.includeGlobs, entry.relative_path)
        and not matches_any(cfg.excludeGlobs, entry.relative_path)
    ]


def _indexable_fingerprint(root: Path, cfg: ContextConfig) -> str:
    entries = _indexable_entries(root, cfg)
    return sha256_text("\n".join(sorted(e.relative_path for e in entries)))


def build_symbol_table(records: List[SourceRecord]) -> Dict[str, List[Dict[str, Any]]]:
    """Build a name-keyed symbol table from all indexed source records.

    Each entry is a list of definition records (multi-definition aware):
    ``[{path, lineStart, lineEnd, kind, language, citation, deterministic, authority}, ...]``
    """
    table: Dict[str, List[Dict[str, Any]]] = {}
    for record in records:
        if not record.content:
            continue
        language = language_for(record.path)
        for sym in extracted_symbols(record.content, record.path):
            entry: Dict[str, Any] = {
                "path": record.path,
                "lineStart": int(sym["line"]),
                "lineEnd": int(sym.get("lineEnd", sym["line"])),
                "kind": sym["kind"],
                "language": language,
                "citation": sym["citation"],
                "deterministic": bool(sym["deterministic"]),
                "authority": record.authority,
            }
            table.setdefault(str(sym["name"]), []).append(entry)
    return table


def _cached_index_is_fresh(root: Path, cfg: ContextConfig, index_path: Path) -> bool:
    """Return True only if no indexed file changed since the index was written.

    Only files that would actually be indexed (matching includeGlobs, not
    excludeGlobs) are considered.  Changes to excluded or non-included paths
    do not invalidate the index.
    """
    freshness_path = index_path.parent / "freshness.json"
    try:
        stored = json.loads(freshness_path.read_text(encoding="utf-8"))
        index_mtime = index_path.stat().st_mtime
    except (OSError, ValueError):
        return False
    # Only consider files that would actually be indexed — via the shared
    # helper so write and check sides can never diverge.
    indexable = _indexable_entries(root, cfg)
    fp = sha256_text("\n".join(sorted(e.relative_path for e in indexable)))
    if fp != stored.get("sourceTreeFingerprint"):
        return False
    for entry in indexable:
        try:
            if entry.full_path.stat().st_mtime > index_mtime:
                return False
        except OSError:
            return False
    return True


def _source_record_from_json(data: Dict[str, Any]) -> SourceRecord:
    """Reconstruct a SourceRecord from its persisted JSON representation."""
    f = data.get("freshness") or {}
    return SourceRecord(
        id=data["id"],
        sourceType=data["sourceType"],
        path=data["path"],
        contentHash=data["contentHash"],
        modifiedAt=data.get("modifiedAt"),
        freshness=Freshness(
            status=f.get("status", "fresh"),
            observedAt=f.get("observedAt"),
            expiresAt=f.get("expiresAt"),
        ),
        authority=data.get("authority", "local"),
        visibility=data.get("visibility", "internal"),
        linkedIssues=data.get("linkedIssues") or [],
        linkedPullRequests=data.get("linkedPullRequests") or [],
        chunkIds=data.get("chunkIds") or [],
        auditRef=data.get("auditRef", ""),
        redactions=[RedactionFinding(**r) for r in (data.get("redactions") or [])],
        content=data.get("content"),
        memory=data.get("memory"),
        priorMistake=data.get("priorMistake"),
    )


def _chunk_record_from_json(data: Dict[str, Any]) -> ChunkRecord:
    """Reconstruct a ChunkRecord from its persisted JSON representation."""
    return ChunkRecord(
        id=data["id"],
        sourceId=data["sourceId"],
        sourceType=data["sourceType"],
        path=data["path"],
        language=data.get("language", ""),
        headingPath=data.get("headingPath") or [],
        parentContext=data.get("parentContext", ""),
        startLine=data.get("startLine"),
        endLine=data.get("endLine"),
        symbolHints=data.get("symbolHints") or [],
        importHints=data.get("importHints") or [],
        textHash=data.get("textHash", ""),
        summary=data.get("summary"),
        citation=data.get("citation", ""),
        content=data.get("content", ""),
        memory=data.get("memory"),
        priorMistake=data.get("priorMistake"),
        symbol=data.get("symbol"),
        kind=data.get("kind"),
    )


def _load_existing_records_and_chunks(
    index_path: Path,
) -> Tuple[Dict[str, SourceRecord], Dict[str, List[ChunkRecord]]]:
    """Load SourceRecords and ChunkRecords from a persisted index.json.

    Returns (records_by_path, chunks_by_source_id).  Both dicts are empty if
    the index is missing or malformed.
    """
    try:
        data = json.loads(index_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}, {}
    records_by_path: Dict[str, SourceRecord] = {}
    for rec_data in data.get("records") or []:
        try:
            rec = _source_record_from_json(rec_data)
            records_by_path[rec.path] = rec
        except (KeyError, TypeError):
            continue
    chunks_by_source_id: Dict[str, List[ChunkRecord]] = {}
    for chunk_data in data.get("chunks") or []:
        try:
            chunk = _chunk_record_from_json(chunk_data)
            chunks_by_source_id.setdefault(chunk.sourceId, []).append(chunk)
        except (KeyError, TypeError):
            continue
    return records_by_path, chunks_by_source_id


def build_index(target_dir: Path, config: ContextConfig | None = None) -> Dict[str, Any]:
    root = target_dir.resolve()
    index_path = root / ".agentrail" / "context" / "index" / "index.json"
    cfg = config or read_context_config(root)
    # Content-based cache: return cached result when nothing changed, regardless of age.
    # _BUILD_INDEX_STALENESS_SECONDS is kept as a constant for callers that may read it,
    # but the cache decision is driven entirely by _cached_index_is_fresh.
    if _cached_index_is_fresh(root, cfg, index_path):
        try:
            index_data = load_index(root)
            snap = index_data.get("snapshot") or {}
            prov = index_data.get("provider") or {}
            prov_sum = prov.get("summary") or {}
            ingestion_health = index_data.get("ingestionHealth") or snap.get("ingestionHealth") or {}
            return {
                "indexPath": ".agentrail/context/index/index.json",
                "auditPath": ".agentrail/context/audit/events.jsonl",
                "embeddingPayloadPath": ".agentrail/context/index/embedding-payloads.jsonl",
                "providerMode": prov.get("mode", "disabled"),
                "summaryMode": prov_sum.get("mode", "disabled"),
                "commitSha": snap.get("commitSha", ""),
                "graphNodes": len((index_data.get("graph") or {}).get("nodes") or []),
                "graphEdges": len((index_data.get("graph") or {}).get("edges") or []),
                "ingestionHealth": ingestion_health,
                "indexed": len(index_data.get("records") or []),
                "chunks": len(index_data.get("chunks") or []),
                "skipped": snap.get("skipped", 0),
                "redactions": snap.get("redactionCount", 0),
                "cacheHit": True,
                "reusedSources": len(index_data.get("records") or []),
                "rebuiltSources": 0,
            }
        except OSError:
            pass  # Index disappeared between check and read — fall through to rebuild
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

    # Load existing records for incremental reuse.
    old_records, old_chunks_by_source_id = _load_existing_records_and_chunks(index_path)
    had_prior_index = bool(old_records)
    try:
        index_mtime: Optional[float] = index_path.stat().st_mtime
    except OSError:
        index_mtime = None

    walked = walk_files(root, cfg.excludeGlobs, include_skipped_dirs=True)
    ignored = git_ignored_set(root, [file.relative_path for file in walked if not file.directory], cfg.respectGitIgnore)
    records: List[SourceRecord] = []
    chunks: List[ChunkRecord] = []
    skipped = 0
    redaction_count = 0
    skipped_records: List[Dict[str, Any]] = []
    reused_sources = 0
    rebuilt_sources = 0

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
        # Incremental reuse: if the file has not been modified since the last index
        # write AND we have a stored record, skip re-reading and re-chunking.
        old_rec = old_records.get(file.relative_path)
        if (
            old_rec is not None
            and index_mtime is not None
            and stats.st_mtime <= index_mtime
        ):
            records.append(old_rec)
            chunks.extend(old_chunks_by_source_id.get(old_rec.id) or [])
            reused_sources += 1
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
        content_hash = sha256_text(redacted_text)
        # Content-hash reuse: mtime changed but content is identical (e.g. touch or
        # a git operation that preserved the bytes).
        if old_rec is not None and old_rec.contentHash == content_hash:
            records.append(old_rec)
            chunks.extend(old_chunks_by_source_id.get(old_rec.id) or [])
            reused_sources += 1
            continue
        record = source_record_for_file(file.full_path, file.relative_path, content_hash=content_hash, content=redacted_text, redactions=redactions)
        source_chunks = chunks_for_source(record, file.relative_path, redacted_text)
        record.chunkIds = [chunk.id for chunk in source_chunks]
        records.append(record)
        chunks.extend(source_chunks)
        rebuilt_sources += 1
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
        rebuilt_sources += 1
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
    symbol_table = build_symbol_table(records)
    index = {
        "schemaVersion": 2,
        "version": "context-index-v1",
        "builtAt": built_at,
        "snapshot": snapshot,
        "provider": {"mode": provider_mode, "summary": {"mode": summary_mode, "provider": cfg.summary.provider, "model": cfg.summary.model}, "externalCalls": []},
        "graph": graph,
        "symbolTable": symbol_table,
        "records": [record.to_json(include_content=True) for record in records],
        "chunks": [chunk.to_json() for chunk in chunks],
        "skipped": skipped_records,
    }
    write_json(index_dir / "index.json", index)
    # Fingerprint over the glob-filtered indexable set — the SAME set that
    # _cached_index_is_fresh checks (via the shared helper). Deriving it from
    # records would drop binary/gitignored/oversized files and cause a
    # permanent cache miss on any real repo.
    write_json(index_dir / "freshness.json", {"sourceTreeFingerprint": _indexable_fingerprint(root, cfg), "builtAt": built_at})
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
        "cacheHit": "incremental" if had_prior_index else False,
        "reusedSources": reused_sources,
        "rebuiltSources": rebuilt_sources,
    }


_index_cache: Dict[str, tuple] = {}


def load_index(target_dir: Path) -> Dict[str, Any]:
    index_path = target_dir.resolve() / ".agentrail" / "context" / "index" / "index.json"
    cache_key = str(index_path)
    try:
        mtime = index_path.stat().st_mtime
    except OSError:
        mtime = 0.0
    cached = _index_cache.get(cache_key)
    if cached and cached[0] == mtime:
        return cached[1]
    data = json.loads(index_path.read_text(encoding="utf-8"))
    # schemaVersion 1 → 2 migration: treat absent symbolTable as empty dict.
    # Do NOT mutate schemaVersion — callers may need to detect the legacy schema.
    data.setdefault("symbolTable", {})
    _index_cache[cache_key] = (mtime, data)
    return data

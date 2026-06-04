from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from agentrail.context.index import append_audit, load_index
from agentrail.shared.json import write_json


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _relative(root: Path, path: Path) -> str:
    return str(path.relative_to(root)).replace("/", "/")


def _record_text(source: Dict[str, Any], chunk: Optional[Dict[str, Any]]) -> str:
    return "\n".join([str(source.get("path", "")), str(source.get("sourceType", "")), str((chunk or {}).get("content") or source.get("content") or ""), str((chunk or {}).get("citation", "")), str((chunk or {}).get("parentContext", "")), json.dumps((chunk or {}).get("headingPath", [])), json.dumps((chunk or {}).get("symbolHints", [])), json.dumps((chunk or {}).get("importHints", [])), json.dumps(source.get("linkedIssues", [])), json.dumps(source.get("linkedPullRequests", []))]).lower()


def _redaction_count(source: Dict[str, Any]) -> int:
    return sum(int(item.get("count", 0)) for item in source.get("redactions", []) if isinstance(item, dict))


def _authority_boost(source: Dict[str, Any]) -> float:
    if source.get("authority") == "critical":
        return 0.3
    if source.get("authority") == "high":
        return 0.2
    return 0.0


def _bounded_content(source: Dict[str, Any], chunk: Optional[Dict[str, Any]]) -> Any:
    content = (chunk or {}).get("content") if chunk else source.get("content")
    if isinstance(content, str) and len(content) > 2000:
        return f"{content[:2000]}\n[TRUNCATED]"
    return content


def build_context_pack(target_dir: Path, target_kind: str, target_number: int, phase: str) -> Dict[str, Any]:
    root = target_dir.resolve()
    if target_kind not in {"issue", "pr"}:
        raise RuntimeError("context build requires target kind: issue or pr")
    if target_kind == "issue" and phase not in {"plan", "execute", "verify"} or target_kind == "pr" and phase != "review":
        raise RuntimeError("context build phase must be one of: issue plan|execute|verify, pr review")
    index_path = root / ".agentrail" / "context" / "index" / "index.json"
    if not index_path.exists():
        raise RuntimeError("context index is missing; run `agentrail context index --target <dir>` first")
    index = load_index(root)
    generated_at = _now()
    generated_slug = generated_at.replace("-", "").replace(":", "").replace(".", "")
    pack_id = f"{target_kind}-{target_number}-{phase}-{generated_slug}"
    target_token = f"#{target_number}".lower()
    target_url = f"/{'issues' if target_kind == 'issue' else 'pull'}/{target_number}".lower()
    sources = {record["id"]: record for record in index.get("records", [])}
    items = [(sources.get(chunk.get("sourceId"), {}), chunk) for chunk in index.get("chunks", [])] if index.get("chunks") else [(record, None) for record in index.get("records", [])]
    prioritized: List[Dict[str, Any]] = []
    for source, chunk in items:
        text = _record_text(source, chunk)
        chunk_linked = bool(chunk) and (target_token in text or target_url in text)
        source_linked = target_number in source.get("linkedIssues" if target_kind == "issue" else "linkedPullRequests", [])
        single = bool(chunk) and len(source.get("chunkIds", [])) == 1
        linked = chunk_linked or (single and source_linked) if chunk else source_linked
        deterministic = 4 if linked else 0
        if source.get("authority") == "critical":
            deterministic += 2
        keyword = (2 if target_token in text or target_url in text else 0) + (1 if phase.lower() in text else 0)
        authority = _authority_boost(source) if deterministic or keyword else 0
        score = {"deterministic": deterministic, "keyword": keyword, "embedding": None, "authorityBoost": authority, "redaction": min(_redaction_count(source) * 0.01, 0.05), "final": deterministic + keyword + authority}
        if score["final"] > 0:
            prioritized.append({"source": source, "chunk": chunk, "score": score})
    prioritized.sort(key=lambda item: (-item["score"]["final"], str((item["chunk"] or {}).get("citation") or item["source"].get("path"))))
    included = []
    for item in prioritized[:20]:
        source = item["source"]
        chunk = item["chunk"]
        included.append({"kind": "indexed_context", "sourceType": source.get("sourceType"), "path": source.get("path"), "sourceId": source.get("id"), "chunkId": (chunk or {}).get("id"), "reason": f"Included from source-citable chunk {(chunk or {}).get('citation')}; matched {(chunk or {}).get('parentContext') or source.get('path')}." if chunk else "Included from the local redacted context index.", "citation": (chunk or {}).get("citation") or source.get("path"), "contentHash": source.get("contentHash"), "textHash": (chunk or {}).get("textHash"), "headingPath": (chunk or {}).get("headingPath", []), "parentContext": (chunk or {}).get("parentContext") or source.get("path"), "matchContext": " > ".join([value for value in [source.get("path"), (chunk or {}).get("parentContext"), *((chunk or {}).get("headingPath", []))] if value]), "symbolHints": (chunk or {}).get("symbolHints", []), "importHints": (chunk or {}).get("importHints", []), "memory": (chunk or {}).get("memory") or source.get("memory"), "redactions": source.get("redactions", []), "content": _bounded_content(source, chunk), "score": item["score"]})
    excluded = [{"sourceType": "path", "path": item.get("path"), "reason": item.get("reason"), "citation": ".agentrail/context/index/index.json"} for item in index.get("skipped", [])]
    pack = {"schemaVersion": 1, "packId": pack_id, "target": {"kind": target_kind, "number": target_number, "phase": phase}, "generatedAt": generated_at, "index": {"version": index.get("version"), "builtAt": index.get("builtAt")}, "retrievalBudget": {"maxItems": 20, "maxTokens": 6000}, "provider": index.get("provider") or {"mode": "disabled", "externalCalls": []}, "goal": {"summary": f"{target_kind} #{target_number} {phase} context pack", "citation": f"github:{target_kind}/{target_number}"}, "included": included, "excluded": excluded, "openQuestions": []}
    packs_dir = root / ".agentrail" / "context" / "packs"
    json_path = packs_dir / f"{pack_id}.json"
    md_path = packs_dir / f"{pack_id}.md"
    write_json(json_path, pack)
    md_path.write_text("\n".join([f"# Context Pack: {target_kind} #{target_number} {phase}", "", f"Goal: {pack['goal']['summary']}", "", "## Included Context", *[f"- `{item['path']}`: {item['reason']}" for item in included], "", "## Excluded Context", *([f"- `{item['path']}`: {item['reason']}" for item in excluded] if excluded else ["None."]), "", "## Provider", f"Mode: {pack['provider'].get('mode')}", ""]) , encoding="utf-8")
    append_audit(root, {"event": "generated_context_pack", "packId": pack_id, "target": pack["target"], "jsonPath": _relative(root, json_path), "markdownPath": _relative(root, md_path), "includedCount": len(included), "excludedCount": len(excluded), "providerMode": pack["provider"].get("mode")})
    return {"jsonPath": _relative(root, json_path), "markdownPath": _relative(root, md_path), "packId": pack_id}

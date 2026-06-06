from __future__ import annotations

import hashlib
import json
import math
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from agentrail.context.compiler import compiler_contract
from agentrail.context.config import read_context_config
from agentrail.context.embeddings import embedding_config_hash, provider_name, configured_model, run_custom_command, run_openai_compatible
from agentrail.context.index import append_audit, build_index, load_index
from agentrail.shared.fs import sha256_text


def tokenize(text: str) -> List[str]:
    return re.findall(r"[a-z0-9_.-]+/[a-z0-9_./-]+|[#]?\d+|[a-z][a-z0-9_-]*|[a-z0-9_.-]+", text.lower())


def unique(values: List[str]) -> List[str]:
    seen: Set[str] = set()
    result: List[str] = []
    for value in values:
        if value not in seen:
            seen.add(value)
            result.append(value)
    return result


def issue_refs(text: str) -> List[int]:
    refs: Set[int] = set()
    for match in re.finditer(r"(?:^|[^A-Za-z])#(\d+)\b", text):
        prefix = text[: match.start() + len(match.group(0)) - len(match.group(1)) - 1]
        if re.search(r"(?:^|\b)(?:pr|pull\s+request)\s*$", prefix, re.IGNORECASE):
            continue
        refs.add(int(match.group(1)))
    refs.update(int(match.group(1)) for match in re.finditer(r"/issues/(\d+)\b", text))
    return sorted(refs)


def pr_refs(text: str) -> List[int]:
    refs = {int(match.group(1)) for match in re.finditer(r"/pull/(\d+)\b", text)}
    refs.update(int(match.group(1)) for match in re.finditer(r"\bpr\s*#?(\d+)\b", text, re.IGNORECASE))
    refs.update(int(match.group(1)) for match in re.finditer(r"\bpull\s+request\s*#?(\d+)\b", text, re.IGNORECASE))
    return sorted(refs)


def score_authority(record: Dict[str, Any]) -> float:
    if record.get("authority") == "critical":
        return 0.45
    if record.get("authority") == "high":
        return 0.3
    return 0.0


def authority_demotion(record: Dict[str, Any]) -> float:
    if record.get("authority") == "low":
        return 0.45
    if record.get("authority") == "denied":
        return 999.0
    return 0.0


def memory_freshness(memory: Optional[Dict[str, Any]]) -> Tuple[float, List[str]]:
    if not memory:
        return 0.0, []
    demotion = 0.0
    reasons: List[str] = []
    now = datetime.now(timezone.utc).timestamp()
    if memory.get("expires_at"):
        try:
            expires = datetime.fromisoformat(str(memory["expires_at"]).replace("Z", "+00:00")).timestamp()
            if expires < now:
                demotion += 1.5
                reasons.append("expired memory")
        except Exception:
            pass
    if memory.get("created_at"):
        try:
            created = datetime.fromisoformat(str(memory["created_at"]).replace("Z", "+00:00")).timestamp()
            if created < now - 180 * 24 * 60 * 60:
                demotion += 0.4
                reasons.append("stale memory")
        except Exception:
            pass
    if str(memory.get("confidence", "")).lower() == "low":
        demotion += 0.25
        reasons.append("low-confidence memory")
    return demotion, reasons


def freshness_demotion(record: Dict[str, Any], chunk: Optional[Dict[str, Any]]) -> Tuple[float, List[str]]:
    status = str(record.get("freshness", {}).get("status", "current")).lower()
    demotion = 0.0
    reasons: List[str] = []
    if status == "expired":
        demotion += 1.5
        reasons.append("expired source")
    elif status == "stale":
        demotion += 0.75
        reasons.append("stale source")
    elif status == "unknown":
        demotion += 0.15
        reasons.append("unknown freshness")
    memory_demotion, memory_reasons = memory_freshness((chunk or {}).get("memory") or record.get("memory"))
    return demotion + memory_demotion, reasons + memory_reasons


def prior_mistake_demotion(prior_mistake: Optional[Dict[str, Any]], effective_issue_refs: List[int]) -> Tuple[float, List[str]]:
    if not prior_mistake:
        return 0.0, []
    issue = prior_mistake.get("issue")
    same_issue = isinstance(issue, int) and issue in effective_issue_refs
    status = str(prior_mistake.get("status") or "").lower()
    if same_issue:
        return 0.0, []
    if status in {"stale", "expired"}:
        return 1.25, ["stale prior mistake"]
    if status in {"resolved", "closed", "done", "fixed", "merged"}:
        return 1.5, ["resolved prior mistake"]
    if isinstance(issue, int):
        return 2.0, ["unrelated prior mistake"]
    return 0.0, []


def record_text(source: Dict[str, Any], chunk: Optional[Dict[str, Any]]) -> str:
    return "\n".join([
        str(source.get("path", "")),
        str(source.get("id", "")),
        str(source.get("sourceType", "")),
        str(source.get("authority", "")),
        str((chunk or {}).get("content") or source.get("content") or ""),
        str((chunk or {}).get("citation", "")),
        str((chunk or {}).get("parentContext", "")),
        json.dumps((chunk or {}).get("headingPath", [])),
        json.dumps((chunk or {}).get("symbolHints", [])),
        json.dumps((chunk or {}).get("importHints", [])),
        json.dumps((chunk or {}).get("priorMistake") or source.get("priorMistake") or {}),
        json.dumps(source.get("linkedIssues", [])),
        json.dumps(source.get("linkedPullRequests", [])),
    ])


def reciprocal_rank(rank: int) -> float:
    return 1 / (60 + rank) if rank > 0 else 0.0


def build_reason(parts: Set[str]) -> str:
    ordered = ["deterministic required context", "active workflow state", "same issue prior failure", "prior mistake", "linked issue", "linked pull request", "exact identifier", "exact path", "BM25 keyword match", "embedding similarity", "high authority source", "current memory", "stale memory", "expired memory", "stale prior mistake", "resolved prior mistake", "unrelated prior mistake", "low authority source"]
    return "; ".join(item for item in ordered if item in parts) or "Included by hybrid retrieval score."


def bounded_content(source: Dict[str, Any], chunk: Optional[Dict[str, Any]]) -> Any:
    content = (chunk or {}).get("content") if chunk else source.get("content")
    if isinstance(content, str) and len(content) > 2000:
        return f"{content[:2000]}\n[TRUNCATED]"
    return content


def cosine_similarity(a: List[float], b: List[float]) -> float:
    if not a or len(a) != len(b):
        return 0.0
    dot = sum(left * right for left, right in zip(a, b))
    left_norm = math.sqrt(sum(left * left for left in a))
    right_norm = math.sqrt(sum(right * right for right in b))
    return dot / (left_norm * right_norm) if left_norm and right_norm else 0.0


def query_context(target_dir: Path, query: str, *, limit: int = 20) -> Dict[str, Any]:
    root = target_dir.resolve()
    build_index(root)
    index = load_index(root)
    sources = {record["id"]: record for record in index.get("records", [])}
    items = [(sources.get(chunk.get("sourceId"), {}), chunk) for chunk in index.get("chunks", [])] if index.get("chunks") else [(record, None) for record in index.get("records", [])]
    query_tokens = unique(tokenize(query))
    query_lower = query.lower()
    query_issue_refs = issue_refs(query)
    query_pr_refs = pr_refs(query)
    try:
        state = json.loads((root / ".agentrail" / "state.json").read_text(encoding="utf-8"))
        active_issue = int(state.get("workflow", {}).get("activeIssue") or state.get("workflow", {}).get("activeRun", {}).get("targetIssue") or 0) or None
    except Exception:
        active_issue = None
    effective_issue_refs = query_issue_refs or ([] if query_pr_refs or not active_issue else [active_issue])

    corpus: List[Dict[str, Any]] = []
    for source, chunk in items:
        text = record_text(source, chunk)
        tokens = tokenize(text)
        term_counts: Dict[str, int] = {}
        for token in tokens:
            term_counts[token] = term_counts.get(token, 0) + 1
        corpus.append({"source": source, "chunk": chunk, "text": text, "textLower": text.lower(), "tokens": tokens, "termCounts": term_counts})
    doc_count = max(1, len(corpus))
    avg_len = sum(len(doc["tokens"]) for doc in corpus) / doc_count if corpus else 1
    doc_freq = {token: sum(1 for doc in corpus if token in doc["termCounts"]) for token in query_tokens}

    scored: List[Dict[str, Any]] = []
    lexical_raw: Dict[str, float] = {}
    phrases = re.findall(r"[a-z0-9_-]+(?:\s+[a-z0-9_-]+){1,4}", query_lower)
    for doc in corpus:
        source = doc["source"]
        chunk = doc["chunk"]
        reasons: Set[str] = set()
        deterministic = keyword = bm25 = 0.0
        linked_issue = any(number in source.get("linkedIssues", []) for number in effective_issue_refs)
        linked_pr = any(number in source.get("linkedPullRequests", []) for number in query_pr_refs)
        same_issue = source.get("sourceType") == "run_artifact" and any(f"issue-{number}" in doc["textLower"] or f'"issue": {number}' in doc["textLower"] or f'targetissue": {number}' in doc["textLower"] for number in effective_issue_refs)
        if source.get("path") == ".agentrail/state.json" and active_issue and active_issue in effective_issue_refs:
            deterministic += 4; reasons.update({"active workflow state", "deterministic required context"})
        if same_issue:
            deterministic += 3.5; reasons.add("same issue prior failure")
        if linked_issue:
            deterministic += 3; reasons.add("linked issue")
        if linked_pr:
            deterministic += 2.5; reasons.add("linked pull request")
        if source.get("sourceType") in {"context_doc", "taste_doc"} and re.search(r"context|taste|required", query_lower):
            deterministic += 2; reasons.add("deterministic required context")
        for number in effective_issue_refs:
            if f"#{number}" in doc["textLower"] or f"/issues/{number}" in doc["textLower"]:
                keyword += 2; reasons.add("exact identifier")
        for number in query_pr_refs:
            if f"/pull/{number}" in doc["textLower"] or f"pr #{number}" in doc["textLower"]:
                keyword += 1.5; reasons.add("exact identifier")
        for token in query_tokens:
            if "/" in token and token in doc["textLower"]:
                keyword += 1.5; reasons.add("exact path")
            tf = doc["termCounts"].get(token, 0)
            if tf:
                df = doc_freq.get(token, 0)
                idf = math.log(1 + (doc_count - df + 0.5) / (df + 0.5))
                bm25 += idf * ((tf * 2.2) / (tf + 1.2 * (1 - 0.75 + 0.75 * (len(doc["tokens"]) / avg_len))))
        for phrase in phrases:
            if len(phrase) > 8 and phrase in doc["textLower"]:
                keyword += 1; reasons.add("exact identifier")
        if bm25 > 0:
            reasons.add("BM25 keyword match")
        authority_boost = score_authority(source)
        if authority_boost > 0:
            reasons.add("high authority source")
        authority_penalty = authority_demotion(source)
        if 0 < authority_penalty < 999:
            reasons.add("low authority source")
        freshness_penalty, freshness_reasons = freshness_demotion(source, chunk)
        reasons.update(freshness_reasons)
        prior_mistake = (chunk or {}).get("priorMistake") or source.get("priorMistake")
        prior_penalty, prior_reasons = prior_mistake_demotion(prior_mistake, effective_issue_refs)
        reasons.update(prior_reasons)
        if prior_mistake:
            reasons.add("prior mistake")
        if ((chunk or {}).get("memory") or source.get("memory")) and freshness_penalty == 0:
            reasons.add("current memory")
        item_id = (chunk or {}).get("id") or source.get("id")
        lexical = deterministic + keyword + bm25
        lexical_raw[str(item_id)] = lexical
        scored.append({"source": source, "chunk": chunk, "reasons": reasons, "score": {"deterministic": deterministic, "keyword": keyword, "bm25": bm25, "embedding": None, "rrf": 0.0, "authorityBoost": authority_boost, "authorityDemotion": 0 if authority_penalty >= 999 else authority_penalty, "freshnessDemotion": freshness_penalty, "priorMistakeDemotion": prior_penalty, "final": 0.0}})

    lexical_rank = {str((entry["chunk"] or {}).get("id") or entry["source"].get("id")): idx + 1 for idx, entry in enumerate(sorted([entry for entry in scored if lexical_raw[str((entry["chunk"] or {}).get("id") or entry["source"].get("id"))] > 0], key=lambda entry: lexical_raw[str((entry["chunk"] or {}).get("id") or entry["source"].get("id"))], reverse=True))}
    provider: Dict[str, Any] = {"mode": "disabled", "provider": None, "model": None}
    embedding_cfg = read_context_config(root).embedding
    embedding_mode = embedding_cfg.mode
    if embedding_mode not in {"disabled", "custom-command", "openai-compatible"}:
        raise RuntimeError(f"context embedding mode '{embedding_mode}' is not supported by this AgentRail version; config is reserved for future provider extension")
    query_vector: Optional[List[float]] = None
    embedding_records: List[Dict[str, Any]] = []
    if embedding_mode != "disabled" and (root / ".agentrail/context/index/embeddings.json").exists():
        parsed = json.loads((root / ".agentrail/context/index/embeddings.json").read_text(encoding="utf-8"))
        embedding_records = parsed.get("embeddings", []) if isinstance(parsed.get("embeddings"), list) else []
        provider = parsed.get("provider") or {"mode": embedding_mode, "provider": provider_name(embedding_mode, embedding_cfg), "model": configured_model(embedding_mode, embedding_cfg)}
        if embedding_records:
            payload = {"mode": embedding_mode, "provider": provider_name(embedding_mode, embedding_cfg), "model": configured_model(embedding_mode, embedding_cfg), "chunkId": "query", "path": "query", "citation": "query", "contentHash": sha256_text(query), "textHash": sha256_text(query), "auditRef": f"audit:query:{sha256_text(query)[7:19]}", "content": query}
            append_audit(root, {"event": "embedding_provider_call", "mode": embedding_mode, "provider": payload["provider"], "model": payload["model"], "action": "embed_query", "queryHash": payload["textHash"]})
            try:
                query_vector = (run_custom_command(root, embedding_cfg, payload) if embedding_mode == "custom-command" else run_openai_compatible(embedding_cfg, payload))["vector"]
            except Exception:
                append_audit(root, {"event": "embedding_provider_failure", "mode": embedding_mode, "provider": payload["provider"], "model": payload["model"], "action": "embed_query_failed", "queryHash": payload["textHash"], "auditRef": payload["auditRef"], "message": "embedding provider failed"})
                query_vector = None
    semantic_rank: Dict[str, int] = {}
    if query_vector:
        by_chunk = {record.get("chunkId"): record for record in embedding_records}
        ranked: List[Tuple[float, Dict[str, Any]]] = []
        config_hash = embedding_config_hash(embedding_mode, embedding_cfg)
        for entry in scored:
            chunk = entry["chunk"]
            if not chunk:
                continue
            emb = by_chunk.get(chunk.get("id"))
            source = entry["source"]
            if emb and emb.get("mode") == embedding_mode and emb.get("configHash") == config_hash and emb.get("textHash") == chunk.get("textHash") and emb.get("contentHash") == source.get("contentHash"):
                similarity = max(0.0, cosine_similarity(query_vector, emb.get("embedding", [])))
                if similarity > 0:
                    entry["score"]["embedding"] = similarity
                    entry["reasons"].add("embedding similarity")
                    ranked.append((similarity, entry))
        semantic_rank = {str((entry["chunk"] or {}).get("id") or entry["source"].get("id")): idx + 1 for idx, (_score, entry) in enumerate(sorted(ranked, key=lambda item: item[0], reverse=True))}

    excluded = []
    for item in index.get("skipped", []):
        excluded.append(
            {
                "sourceType": "path",
                "path": item.get("path"),
                "sourceId": item.get("sourceId"),
                "reason": item.get("reason"),
                "citation": ".agentrail/context/index/index.json",
                "authority": item.get("authority"),
                "visibility": item.get("visibility"),
                "freshness": item.get("freshness"),
                "redactions": item.get("redactions", []),
            }
        )
    results = []
    for entry in scored:
        source = entry["source"]
        if source.get("authority") == "denied" or source.get("visibility") == "denied":
            excluded.append(
                {
                    "sourceType": source.get("sourceType"),
                    "path": source.get("path"),
                    "reason": "denied_source",
                    "citation": source.get("path"),
                    "authority": source.get("authority"),
                    "visibility": source.get("visibility"),
                    "freshness": source.get("freshness"),
                    "redactions": source.get("redactions", []),
                }
            )
            continue
        item_id = str((entry["chunk"] or {}).get("id") or source.get("id"))
        entry["score"]["rrf"] = reciprocal_rank(lexical_rank.get(item_id, 0)) + reciprocal_rank(semantic_rank.get(item_id, 0))
        semantic = entry["score"]["embedding"] or 0.0
        entry["score"]["final"] = lexical_raw[item_id] + semantic * 2 + entry["score"]["rrf"] * 10 + entry["score"]["authorityBoost"] - entry["score"]["authorityDemotion"] - entry["score"]["freshnessDemotion"] - entry["score"]["priorMistakeDemotion"]
        if entry["score"]["final"] > 0:
            results.append(entry)
    results.sort(key=lambda entry: (-entry["score"]["final"], str((entry["chunk"] or {}).get("citation") or entry["source"].get("path"))))
    formatted = []
    for rank, entry in enumerate(results[:limit], 1):
        source = entry["source"]
        chunk = entry["chunk"]
        score = {key: (None if value is None else round(float(value), 6)) for key, value in entry["score"].items()}
        formatted.append({"rank": rank, "kind": "indexed_context", "sourceType": source.get("sourceType"), "path": source.get("path"), "sourceId": source.get("id"), "chunkId": (chunk or {}).get("id"), "citation": (chunk or {}).get("citation") or source.get("path"), "reason": build_reason(entry["reasons"]), "contentHash": source.get("contentHash"), "textHash": (chunk or {}).get("textHash"), "headingPath": (chunk or {}).get("headingPath", []), "parentContext": (chunk or {}).get("parentContext") or source.get("path"), "matchContext": " > ".join([value for value in [source.get("path"), (chunk or {}).get("parentContext"), *((chunk or {}).get("headingPath", []))] if value]), "symbolHints": (chunk or {}).get("symbolHints", []), "importHints": (chunk or {}).get("importHints", []), "memory": (chunk or {}).get("memory") or source.get("memory"), "priorMistake": (chunk or {}).get("priorMistake") or source.get("priorMistake"), "authority": source.get("authority"), "visibility": source.get("visibility"), "freshness": source.get("freshness"), "redactions": source.get("redactions", []), "content": bounded_content(source, chunk), "score": score})
    audit = {
        "event": "context_query",
        "citation": ".agentrail/context/audit/events.jsonl",
        "queryHash": sha256_text(query),
        "resultCount": len(formatted),
        "excludedCount": len(excluded),
        "providerMode": provider.get("mode") or embedding_mode,
    }
    retrieval_budget = {"maxItems": limit, "maxTokens": None}
    output = {
        "schemaVersion": 1,
        "command": "context.query",
        "target": {"kind": "query", "query": query},
        "query": query,
        "limit": limit,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "index": {"version": index.get("version"), "builtAt": index.get("builtAt")},
        "retrievalBudget": retrieval_budget,
        "provider": provider,
        "audit": audit,
        "results": formatted,
        "excluded": excluded,
        "compiler": compiler_contract(
            "query",
            query,
            root=root,
            token_budget=retrieval_budget,
            source_items=formatted,
            excluded_items=excluded,
            compatibility={
                "queryResultsMapTo": "compiler.candidates[kind=source_evidence]",
                "queryExcludedMapTo": "compiler.candidates[kind=excluded_context]",
            },
        ),
    }
    append_audit(root, audit)
    return output

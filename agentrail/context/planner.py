"""Query planner: classify a retrieval query before searching.

The planner inspects a query for concrete anchors (path, symbol, error text,
issue/PR ref, relational language) versus conceptual / task language and chooses
a ``retrievalMode`` so retrieval can route exact, semantic, or hybrid work.

Modes:
  exact        concrete anchor (path / symbol / error text), no conceptual hint
  exact_bm25   issue / PR anchor — exact identifiers plus lexical (BM25) search
  exact_graph  anchor plus relational intent (callers, imports, tests, dependents)
  semantic     conceptual question with no concrete anchor
  hybrid       both concrete anchors and conceptual / task language (or stale memory)
  excluded     denied source (.env, credentials, keys) — never retrieved
"""
from __future__ import annotations

import re
from typing import Any, Dict

_PATH_RE = re.compile(r"[\w.-]+/[\w./-]+")
_PATH_EXT_RE = re.compile(r"\b[\w-]+\.(?:py|ts|tsx|js|jsx|json|md|yml|yaml|toml|go|rs|java|rb|sh)\b")
_SYMBOL_RE = re.compile(r"[A-Za-z_]\w*\(\s*\)")
_FIRST_WORD_RE = re.compile(r"[a-z_][a-z_]*")

_RELATIONAL = (
    "caller", "callers", "who calls", "calls ", "imports", "imported by",
    "depends on", "dependents", "dependent on", "used by", "uses ",
    "tests for", "test for", "references ", "related to", "relationship",
    "subclass", "inherits",
)
_QUESTION_RE = re.compile(r"\b(where|how|what|why|which|when|who|whom)\b")
_TASK_VERBS = {
    "fix", "add", "implement", "refactor", "update", "remove", "improve",
    "create", "change", "debug", "investigate", "handle", "wire", "migrate",
    "rename", "delete", "support", "reduce",
}
_MEMORY_RE = re.compile(r"\b(old|previous|prior|stale|lesson|memory|earlier|past)\b")
_DENIED_RE = re.compile(r"(^|[\s/])\.env\b|\bcredentials?\b|\bsecret\b|\.pem\b|\.key\b")


def _detect_signals(query: str) -> Dict[str, bool]:
    from agentrail.context.retrieval import issue_refs, pr_refs

    ql = query.lower().strip()
    first = _FIRST_WORD_RE.match(ql)
    first_word = first.group(0) if first else ""
    return {
        "denied": bool(_DENIED_RE.search(ql)),
        "path": bool(_PATH_RE.search(query) or _PATH_EXT_RE.search(ql)),
        "symbol": bool(_SYMBOL_RE.search(query)),
        "issuePr": bool(issue_refs(query) or pr_refs(query)),
        "relational": any(token in ql for token in _RELATIONAL),
        "question": ql.endswith("?") or bool(_QUESTION_RE.search(ql)),
        "taskVerb": first_word in _TASK_VERBS,
        "memory": bool(_MEMORY_RE.search(ql)),
    }


def _mode_for(signals: Dict[str, bool]) -> str:
    if signals["denied"]:
        return "excluded"
    has_anchor = signals["path"] or signals["symbol"] or signals["issuePr"]
    conceptual = signals["question"] or signals["taskVerb"]
    if has_anchor and signals["relational"]:
        return "exact_graph"
    if has_anchor and conceptual:
        return "hybrid"
    if signals["issuePr"] and signals["memory"]:
        return "hybrid"
    if signals["issuePr"]:
        return "exact_bm25"
    if signals["symbol"] or signals["path"]:
        return "exact"
    if signals["question"]:
        return "semantic"
    if signals["relational"]:
        return "exact_graph"
    if signals["taskVerb"]:
        return "hybrid"
    # Declarative phrase with no anchor and no conceptual marker: error/log text.
    return "exact"


def classify_query(query: str) -> Dict[str, Any]:
    """Classify a query and return its retrieval mode and detected signals."""
    signals = _detect_signals(query)
    return {"query": query, "retrievalMode": _mode_for(signals), "signals": signals}

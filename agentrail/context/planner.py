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


# Per-source weights the planner emits alongside the retrieval mode (context
# source registry spec §C — docs/superpowers/specs/2026-07-27-context-source-
# registry-design.md). 1.0 is "consult normally"; above boosts, below demotes.
#
# The default is to CONSULT. Skipping a source (weight 0) buys latency and a
# saved round trip, never pack precision -- the pack budget already filters an
# irrelevant candidate out. The errors are asymmetric: consulting a useless
# source costs a few hundred milliseconds the ranker discards, while wrongly
# skipping one removes context the agent cannot know is missing. So nothing
# here emits 0 today, and anything that ever does needs a strong signal behind
# it plus a provenance line naming what was skipped.
_BASE_SOURCE_WEIGHTS = {"code": 1.0, "wiki": 1.0, "memory": 1.0}

# How far a signal moves a source. Deliberately small and few: this is a
# deterministic signal table, not a model, and a table nobody can predict the
# output of is worse than no table at all.
_WIKI_BOOST = 0.4
_WIKI_DEMOTION = 0.4
_MEMORY_BOOST = 0.4
_CODE_BOOST = 0.2


def _source_weights(signals: Dict[str, bool]) -> Dict[str, float]:
    """Per-source weights from the SAME signals that pick the retrieval mode.

    Three rules, each tied to a signal the detector already produces:

    * A concrete anchor (a path or a symbol) means the asker knows where they
      are going — code up, wiki down. Compiled prose about a file is a poor
      substitute for the file when you can already name the file.
    * A conceptual question with no anchor ("how does X work", "where does Y
      live") is exactly what an orientation page answers — wiki up.
    * Memory language (previous, prior, regression, lesson) means the useful
      context is what happened before, not what the code says now — memory up.

    Weighting, not gating, is where the precision is: a regression wants prior
    memory scored ABOVE code, which changes what the agent sees first. Gating
    only changes whether a round trip happens.
    """
    weights = dict(_BASE_SOURCE_WEIGHTS)
    has_anchor = signals["path"] or signals["symbol"]
    if has_anchor:
        weights["code"] += _CODE_BOOST
        weights["wiki"] -= _WIKI_DEMOTION
    if signals["question"] and not has_anchor:
        weights["wiki"] += _WIKI_BOOST
    if signals["memory"]:
        weights["memory"] += _MEMORY_BOOST
    # A denied query retrieves nothing from anywhere -- the mode already says
    # "excluded", and the weights must not disagree with it.
    if signals["denied"]:
        return {name: 0.0 for name in weights}
    return {name: round(weight, 3) for name, weight in weights.items()}


def classify_query(query: str) -> Dict[str, Any]:
    """Classify a query and return its retrieval mode, signals, and source weights.

    ``sources`` is additive: every existing caller reads ``retrievalMode`` and
    ``signals`` and is unaffected by the new key.
    """
    signals = _detect_signals(query)
    return {
        "query": query,
        "retrievalMode": _mode_for(signals),
        "signals": signals,
        "sources": _source_weights(signals),
    }

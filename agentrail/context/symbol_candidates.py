"""Symbol-level candidate generation for the recall layer (#1043 AC4).

The token-splitting query expansion in ``expansion.py`` widens the retrieval
token set with subtokens recovered from the RAW task text.  It cannot recall a
dependency the task never *names*: when ``index.py`` imports
``source_record_for_file`` from ``sources.py`` but the task only says
``build_index``, no token the user typed points at ``sources.py``, so the file
that DEFINES the imported symbol stays outside the pack (measured: distinct-rank
11 / recall 0.667 on ``context-index-build-hard``; rank >25 / recall 0.5 on
``context-pack-build-hard``).

This module closes that gap deterministically.  Given the loaded ``index`` and
the seed/anchor files the retriever already anchored on, it recovers the
**cross-file imported symbols** of those seeds — the identifiers a seed file
imports (or calls) that are DEFINED in a *different* file — and returns both

  * the imported symbol **names** (so the retriever can inject them into the
    query token set and the definition-pattern gate, lifting the file that
    defines each symbol through the normal BM25 + ``symbol definition`` scoring),
    and
  * the ``context_def`` **items** for each name (the exact definition-site
    chunk), so the definition can also be merged into the candidate set directly
    as a recall safety net before the rerank narrows it.

Two independent, deterministic evidence sources are unioned:

  1. **name-import maps** parsed from the seed file text
     (``index._python_name_imports`` / ``index._ts_named_imports``) — the
     ``from X import Y`` / ``import { Y } from './m'`` names a file pulls in, and
  2. the code graph's resolved **``calls`` edges** whose ``callerPath`` is a seed
     — the callees a seed invokes.

A candidate name is kept only when the global ``symbolTable`` resolves it to a
definition site in a file OTHER than the seed (a genuine cross-file dependency;
same-file symbols are already local to the seed and need no recall help).

Fully deterministic (same index + seeds -> identical output; sorted names, no
clock, no network) and side-effect free.  The retriever gates every call to this
module behind ``query_expansion_enabled`` so the default-OFF baseline is
byte-identical.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from agentrail.context.index import _python_name_imports, _ts_named_imports

# Extensions whose named-import syntax the two parsers understand.  Kept in sync
# with the grammars ``_python_name_imports`` / ``_ts_named_imports`` handle.
_PYTHON_EXTS = {".py", ".pyi"}
_TS_EXTS = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}


def _read_text(root: Path, rel_path: str) -> Optional[str]:
    """Best-effort read of a repo-relative file, or ``None`` when unreadable."""
    try:
        fp = (root / rel_path)
        if not fp.is_file():
            return None
        return fp.read_text(encoding="utf-8", errors="replace")
    except (OSError, ValueError):
        return None


def _imported_names_from_text(rel_path: str, text: str) -> Set[str]:
    """Named-import identifiers a file pulls in, by grammar (empty for others)."""
    suffix = Path(rel_path).suffix.lower()
    if suffix in _PYTHON_EXTS:
        return set(_python_name_imports(text).keys())
    if suffix in _TS_EXTS:
        return set(_ts_named_imports(text).keys())
    return set()


def _called_names_from_graph(index: Dict[str, Any], seed_set: Set[str]) -> Set[str]:
    """Callee names invoked by any seed file, from resolved ``calls`` edges."""
    names: Set[str] = set()
    graph = index.get("graph") or {}
    edges = graph.get("edges") or []
    for edge in edges:
        if not isinstance(edge, dict):
            continue
        if edge.get("kind") != "calls":
            continue
        if edge.get("callerPath") not in seed_set:
            continue
        callee = edge.get("callee")
        if callee:
            names.add(str(callee))
    return names


def cross_file_imported_symbols(
    root: Path,
    index: Dict[str, Any],
    seed_paths: List[str],
) -> List[str]:
    """Names imported/called by a seed file and DEFINED in a different file.

    Unions the two deterministic evidence sources (name-import maps parsed from
    each seed's text + resolved ``calls`` edges out of each seed), then keeps
    only names the global ``symbolTable`` resolves to a definition site whose
    path is not the seed itself.  Returns a sorted, de-duplicated list so the
    output is stable for a given index + seed set.
    """
    seed_set = {p for p in seed_paths if p}
    if not seed_set:
        return []
    symbol_table = index.get("symbolTable") or {}

    candidate_names: Set[str] = _called_names_from_graph(index, seed_set)
    for seed in seed_set:
        text = _read_text(root, seed)
        if text is not None:
            candidate_names |= _imported_names_from_text(seed, text)

    kept: Set[str] = set()
    for name in candidate_names:
        records = symbol_table.get(name) or []
        for rec in records:
            if not isinstance(rec, dict):
                continue
            if rec.get("authority") == "denied":
                continue
            def_path = rec.get("path")
            # Cross-file only: a symbol defined in the seed itself is already
            # local context and needs no recall injection.
            if def_path and def_path not in seed_set:
                kept.add(name)
                break
    return sorted(kept)


def imported_symbol_candidates(
    root: Path,
    index: Dict[str, Any],
    seed_paths: List[str],
    *,
    context_def: Any,
) -> Tuple[List[str], List[Dict[str, Any]]]:
    """``(names, definition_items)`` for the seeds' cross-file imported symbols.

    ``names`` is the sorted cross-file imported symbol list (see
    ``cross_file_imported_symbols``).  ``definition_items`` concatenates the
    ``context_def(root, name, index=index)`` house-schema items for every name,
    de-duplicated by citation (a symbol with multiple definition sites
    contributes each distinct site once), in a deterministic order.

    ``context_def`` is injected by the caller (``retrieval.context_def``) to
    avoid an import cycle between this module and ``retrieval.py``.
    """
    names = cross_file_imported_symbols(root, index, seed_paths)
    items: List[Dict[str, Any]] = []
    seen: Set[str] = set()
    for name in names:
        for item in context_def(root, name, index=index):
            key = str(item.get("citation") or f"{item.get('path')}:{item.get('lineStart')}")
            if key in seen:
                continue
            seen.add(key)
            # Attribute the symbol identity so downstream (and the merged pack
            # entry) can report WHICH cross-file symbol pulled the file in.
            enriched = dict(item)
            enriched["symbol"] = name
            items.append(enriched)
    return names, items

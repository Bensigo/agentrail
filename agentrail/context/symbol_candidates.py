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

# Tree-sitter symbol kinds that name a DEFINITION site (as opposed to a bare
# reference / call).  A code chunk whose ``kind`` is one of these AND whose
# ``symbol`` equals an imported name is the file that DEFINES that symbol — the
# identity the definition-aware promotion keys on, independent of how many other
# chunks merely mention the token.  Kept broad across the grammars the indexer
# extracts (python / TS / go / rust / c-family) so a definition in any language
# is recognised.
_DEFINITION_KINDS = {
    "function",
    "class",
    "method",
    "interface",
    "type",
    "enum",
    "struct",
    "const",
    "constant",
    "var",
    "module",
    "namespace",
    "trait",
    "impl",
}


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


def definition_site_paths(
    index: Dict[str, Any],
    seed_paths: List[str],
    names: List[str],
) -> Dict[str, Set[str]]:
    """Map each imported ``name`` to the file(s) that DEFINE it, from ``symbolTable``.

    For every name, the global ``symbolTable`` resolves the identifier to its
    definition-site record(s); we keep only definition PATHS that are (a) not the
    seed itself (a genuine cross-file dependency) and (b) not authority-denied.
    This is the definition-site IDENTITY the promotion keys on — a rarity-blind,
    token-frequency-independent lookup: whether ``compute_pack_quality`` appears
    in 1 chunk or 106, ``symbolTable`` still resolves it to exactly the file that
    spells its ``def``.  Names with no surviving cross-file definition are
    omitted, so the returned map only contains promotable symbols.

    Pure and deterministic (index + seeds + names -> identical output).
    """
    seed_set = {p for p in seed_paths if p}
    out: Dict[str, Set[str]] = {}
    symbol_table = index.get("symbolTable") or {}
    for name in names:
        paths: Set[str] = set()
        for rec in symbol_table.get(name) or []:
            if not isinstance(rec, dict):
                continue
            if rec.get("authority") == "denied":
                continue
            def_path = rec.get("path")
            if def_path and def_path not in seed_set:
                paths.add(str(def_path))
        if paths:
            out[name] = paths
    return out


def select_definition_promotions(
    candidates: List[Dict[str, Any]],
    def_site_map: Dict[str, Set[str]],
    *,
    exclude_files: Optional[Set[str]] = None,
) -> List[Dict[str, Any]]:
    """Pick the DEFINITION-SITE chunk for each imported symbol, by IDENTITY.

    Walks ``candidates`` (result-shaped dicts carrying ``symbol`` / ``symbolKind``
    / ``path`` — the per-chunk symbol identity #1103 plumbs through the retrieval
    boundary) and keeps a candidate only when it is the definition site of an
    imported symbol:

      * ``candidate["symbol"]`` is a key of ``def_site_map`` (an imported name),
      * ``candidate["path"]`` is one of that name's ``symbolTable`` definition
        paths, and
      * ``candidate["symbolKind"]`` is a definition kind (``_DEFINITION_KINDS``).

    This is what separates the true defining file from same-token NOISE: a chunk
    that merely *calls* ``compute_pack_quality`` carries the token but not the
    ``symbol==compute_pack_quality`` + definition-kind identity, so it is never
    selected however high BM25 scored it.  The first candidate matching a given
    file wins (callers pass ``candidates`` in rank order, so the highest-ranked
    definition chunk per file is chosen); one promotion per file, and files in
    ``exclude_files`` (already in the pack) are skipped.

    Pure and deterministic: depends only on the passed candidate dicts + map.
    """
    excluded = exclude_files or set()
    picked: List[Dict[str, Any]] = []
    seen_files: Set[str] = set()
    for cand in candidates:
        name = cand.get("symbol")
        path = cand.get("path")
        if not name or not path:
            continue
        if path in excluded or path in seen_files:
            continue
        def_paths = def_site_map.get(name)
        if not def_paths or path not in def_paths:
            continue
        if cand.get("symbolKind") not in _DEFINITION_KINDS:
            continue
        seen_files.add(path)
        picked.append(cand)
    return picked

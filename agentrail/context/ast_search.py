"""AST structural search for indexed code files (M021).

Public API:
    ast_query(root, s_expr, limit=50) -> {"results": [...], "excluded": [...]}

Hot path: uses content stored in index records to avoid re-reading from disk.
Cold path: reads from disk when record content is absent or index is missing.
No daemon required — re-parses on demand using the same grammar dispatch as M018.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional

from agentrail.context.index import build_index, grammar_for, load_index
from agentrail.context.retrieval import estimate_tokens

# Grammars tried for s-expression validity when no code records exist.
_VALIDATION_GRAMMARS = [
    "python", "javascript", "typescript", "go", "rust",
    "java", "ruby", "bash", "c", "cpp",
]


def ast_query(root: Path, s_expr: str, limit: int = 50) -> Dict[str, Any]:
    """Run a tree-sitter s-expression query across indexed code files.

    Args:
        root: Repository root (target directory).
        s_expr: A tree-sitter s-expression query, e.g.
            ``"(function_definition name: (identifier) @fn)"``.
        limit: Maximum results to return (default 50).

    Returns:
        ``{"results": [...], "excluded": [...]}`` where each result item
        follows the house schema:
        ``{path, lineStart, lineEnd, content, citation, reason, score,
           tokenEstimate, deterministic}``.

    Raises:
        ValueError: If the s-expression is invalid for every known grammar.
    """
    import tree_sitter
    import tree_sitter_language_pack

    root = root.resolve()

    # Build (if stale) then load index; tolerant of missing index.
    try:
        build_index(root)
        index = load_index(root)
        records: List[Dict[str, Any]] = index.get("records") or []
    except Exception:
        records = []

    # Compile query per grammar; cache the result (Query object or None for failed).
    compiled: Dict[str, Optional[tree_sitter.Query]] = {}
    any_compiled = False

    def _compiled_query(grammar: str) -> Optional[tree_sitter.Query]:
        nonlocal any_compiled
        if grammar in compiled:
            return compiled[grammar]
        try:
            lang = tree_sitter_language_pack.get_language(grammar)
            q = tree_sitter.Query(lang, s_expr)
            compiled[grammar] = q
            any_compiled = True
            return q
        except (tree_sitter.QueryError, Exception):
            compiled[grammar] = None
            return None

    results: List[Dict[str, Any]] = []
    excluded: List[Dict[str, Any]] = []

    for record in records:
        if not isinstance(record, dict):
            continue
        if record.get("sourceType") != "code":
            continue
        path = record.get("path", "")
        if not path:
            continue

        # Extra denied-source safety filter (denied files are normally absent
        # from records; this guards against any edge case).
        if record.get("authority") == "denied" or record.get("visibility") == "denied":
            excluded.append({"path": path, "reason": "denied_source"})
            continue

        grammar = grammar_for(path)
        if grammar is None:
            continue

        query = _compiled_query(grammar)
        if query is None:
            continue

        # Prefer content from the index record; fall back to reading from disk.
        content: Optional[str] = record.get("content")
        if not isinstance(content, str) or not content:
            try:
                content = (root / path).read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue

        try:
            parser = tree_sitter_language_pack.get_parser(grammar)
            tree = parser.parse(content.encode("utf-8", errors="replace"))
            captures = query.captures(tree.root_node)
        except Exception:
            continue

        lines = content.splitlines()
        for capture_name, nodes in captures.items():
            for node in nodes:
                ls = node.start_point[0] + 1
                le = node.end_point[0] + 1
                node_content = "\n".join(lines[ls - 1:le])
                citation = f"{path}:{ls}-{le}"
                results.append({
                    "path": path,
                    "lineStart": ls,
                    "lineEnd": le,
                    "content": node_content,
                    "citation": citation,
                    "reason": f"AST match: {capture_name}",
                    "score": {"final": 1.0},
                    "tokenEstimate": estimate_tokens(node_content),
                    "deterministic": True,
                })

    # If no grammar compiled the query, validate using fallback grammars.
    # This ensures truly invalid s-expressions raise ValueError even when the
    # repo has no indexed code files.
    if not any_compiled:
        for _grammar in _VALIDATION_GRAMMARS:
            try:
                lang = tree_sitter_language_pack.get_language(_grammar)
                tree_sitter.Query(lang, s_expr)
                any_compiled = True
                break
            except (tree_sitter.QueryError, Exception):
                continue

    if not any_compiled:
        raise ValueError(f"invalid s-expression: {s_expr!r}")

    results.sort(key=lambda item: (item["path"], item["lineStart"], item["lineEnd"], item["reason"]))
    return {
        "results": results[:limit],
        "excluded": excluded,
    }

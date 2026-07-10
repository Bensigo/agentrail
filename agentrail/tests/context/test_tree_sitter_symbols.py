"""Per-language tree-sitter parsing fixture tests (M018).

Each parametrized case reads a fixture file from tests/context/fixtures/tree_sitter/,
calls extracted_symbols(text, path), and asserts the returned list includes at least
the expected symbols matched by name, kind, and line.

Expected symbol data was captured from actual extracted_symbols() output and is
therefore evidence-based, not hand-guessed.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List

import pytest

from agentrail.context.index import extracted_symbols

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "tree_sitter"


def _read(name: str) -> str:
    return (FIXTURE_DIR / name).read_text(encoding="utf-8")


def _assert_symbol(
    syms: List[Dict[str, Any]], name: str, kind: str, line: int
) -> None:
    match = next((s for s in syms if s["name"] == name), None)
    assert match is not None, f"symbol {name!r} not found in {syms}"
    assert match["kind"] == kind, f"wrong kind for {name!r}: got {match['kind']!r}"
    assert match["line"] == line, f"wrong line for {name!r}: got {match['line']}"
    assert match["deterministic"] is True
    assert "parsedBy" not in match, f"tree-sitter symbol should not have parsedBy: {match}"


# Each entry: (fixture_filename, [(name, kind, line), ...])
# Symbol data verified against actual extracted_symbols() output.
_LANGUAGE_CASES = [
    # Python: function_definition + class_definition
    ("sample.py", [("greet", "function", 1), ("Calculator", "class", 9)]),
    # JavaScript: function_declaration + class_declaration + arrow via lexical_declaration
    ("sample.js", [("greet", "function", 1), ("Calculator", "class", 5), ("multiply", "function", 11)]),
    # TypeScript: function + interface + class + type alias
    ("sample.ts", [("greet", "function", 1), ("Shape", "interface", 5), ("Circle", "class", 9), ("Color", "type", 16)]),
    # TSX: same grammar as tsx, function + interface + class + type alias
    ("sample.tsx", [("App", "function", 1), ("ButtonProps", "interface", 5), ("Button", "class", 9), ("Theme", "type", 15)]),
    # Go: function_declaration + type_declaration (struct + interface)
    ("sample.go", [("greet", "function", 3), ("Animal", "struct", 11), ("Stringer", "interface", 16)]),
    # Rust: function_item + struct_item + enum_item + type_item
    ("sample.rs", [("greet", "function", 1), ("Point", "struct", 5), ("Direction", "enum", 10), ("Meters", "type", 17)]),
    # Java: class_declaration + method in class + interface
    ("sample.java", [("Calculator", "class", 1), ("add", "method", 2), ("Shape", "interface", 11)]),
    # Kotlin: function_declaration + class_declaration + object_declaration
    ("sample.kt", [("greet", "function", 1), ("Calculator", "class", 7), ("MathUtils", "class", 11)]),
    # Ruby: method + class + module
    ("sample.rb", [("greet", "function", 1), ("Calculator", "class", 9), ("MathUtils", "class", 15)]),
    # PHP: function_definition + class_declaration + method
    ("sample.php", [("greet", "function", 3), ("Calculator", "class", 11), ("multiply", "method", 12)]),
    # C: function_definition + struct_specifier
    ("sample.c", [("add", "function", 3), ("multiply", "function", 7), ("Point", "struct", 11)]),
    # C++: function_definition + struct_specifier + class_specifier
    ("sample.cpp", [("add", "function", 3), ("Point", "struct", 7), ("Calculator", "class", 12)]),
    # Shell/bash: function_definition (both syntaxes)
    ("sample.sh", [("greet", "function", 3), ("add", "function", 7), ("main", "function", 11)]),
]

_LANGUAGE_IDS = [case[0] for case in _LANGUAGE_CASES]


@pytest.mark.parametrize("fixture_name,expected", _LANGUAGE_CASES, ids=_LANGUAGE_IDS)
def test_language_symbols(fixture_name: str, expected: list) -> None:
    """AC1 + AC2: extracted_symbols returns expected symbols from language fixture."""
    text = _read(fixture_name)
    # Use the fixture filename as the relative path so grammar_for() picks the right grammar
    syms = extracted_symbols(text, fixture_name)
    for name, kind, line in expected:
        _assert_symbol(syms, name, kind, line)


def test_unsupported_extension_fallback() -> None:
    """AC3: .xyz file returns empty list or regex_fallback symbols — no exception."""
    text = "???invalid!!!"
    syms = extracted_symbols(text, "sample.xyz")
    # Must be either empty or every symbol carries parsedBy == "regex_fallback"
    assert isinstance(syms, list)
    for sym in syms:
        assert sym.get("parsedBy") == "regex_fallback", (
            f"unsupported-extension symbol missing parsedBy=regex_fallback: {sym}"
        )

from __future__ import annotations

import unittest

from agentrail.context.index import extracted_symbols


# Each fixture is a minimal valid source file with (at least) one function and
# one class/struct/second-symbol. The expected list records the two primary
# symbols as (name, kind, line). AC3: >=2 symbols extracted per language with
# correct name/kind/line.
LANGUAGE_FIXTURES = {
    "python": (
        "a.py",
        "def foo():\n    pass\n\nclass Bar:\n    pass\n",
        [("foo", "function", 1), ("Bar", "class", 4)],
    ),
    "javascript": (
        "a.js",
        "function foo() {}\n\nclass Bar {}\n",
        [("foo", "function", 1), ("Bar", "class", 3)],
    ),
    "jsx": (
        "a.jsx",
        "function foo() {}\n\nclass Bar {}\n",
        [("foo", "function", 1), ("Bar", "class", 3)],
    ),
    "typescript": (
        "a.ts",
        "function foo(): void {}\n\nclass Bar {}\n",
        [("foo", "function", 1), ("Bar", "class", 3)],
    ),
    "tsx": (
        "a.tsx",
        "function foo() {}\n\nclass Bar {}\n",
        [("foo", "function", 1), ("Bar", "class", 3)],
    ),
    "go": (
        "a.go",
        "package main\n\nfunc Foo() {}\n\ntype Bar struct {}\n",
        [("Foo", "function", 3), ("Bar", "struct", 5)],
    ),
    "rust": (
        "a.rs",
        "fn foo() {}\n\nstruct Bar {}\n",
        [("foo", "function", 1), ("Bar", "struct", 3)],
    ),
    "java": (
        "A.java",
        "class Bar {\n    void foo() {}\n}\n",
        [("Bar", "class", 1), ("foo", "method", 2)],
    ),
    "kotlin": (
        "a.kt",
        "fun foo() {}\n\nclass Bar {}\n",
        [("foo", "function", 1), ("Bar", "class", 3)],
    ),
    "ruby": (
        "a.rb",
        "def foo\nend\n\nclass Bar\nend\n",
        [("foo", "function", 1), ("Bar", "class", 4)],
    ),
    "php": (
        "a.php",
        "<?php\nfunction foo() {}\n\nclass Bar {}\n",
        [("foo", "function", 2), ("Bar", "class", 4)],
    ),
    "c": (
        "a.c",
        "int foo() { return 0; }\n\nstruct Bar { int x; };\n",
        [("foo", "function", 1), ("Bar", "struct", 3)],
    ),
    "c_header": (
        "a.h",
        "struct Bar { int x; };\n\nenum Color { RED };\n",
        [("Bar", "struct", 1), ("Color", "enum", 3)],
    ),
    "cpp": (
        "a.cpp",
        "int foo() { return 0; }\n\nclass Bar {};\n",
        [("foo", "function", 1), ("Bar", "class", 3)],
    ),
    "bash": (
        "a.sh",
        "foo() {\n  echo hi\n}\n\nfunction bar() {\n  echo hi\n}\n",
        [("foo", "function", 1), ("bar", "function", 5)],
    ),
}


class TreeSitterSymbolTests(unittest.TestCase):
    def test_each_language_extracts_expected_symbols(self) -> None:
        for language, (path, text, expected) in LANGUAGE_FIXTURES.items():
            with self.subTest(language=language):
                symbols = extracted_symbols(text, path)
                triples = [(s["name"], s["kind"], s["line"]) for s in symbols]
                # AC3: at least two symbols from the minimal fixture (c_header
                # is a single-symbol declaration-only case, asserted exactly).
                self.assertGreaterEqual(
                    len(symbols), 2,
                    f"{language}: expected >=2 symbols, got {triples}",
                )
                for want in expected:
                    self.assertIn(want, triples, f"{language}: missing {want} in {triples}")

    def test_tree_sitter_symbols_use_house_schema(self) -> None:
        symbols = extracted_symbols("def foo():\n    pass\nclass Bar:\n    pass\n", "a.py")
        self.assertTrue(symbols)
        for sym in symbols:
            self.assertEqual(set(sym.keys()), {"name", "kind", "line", "citation", "deterministic"})
            self.assertTrue(sym["deterministic"])
            self.assertNotIn("parsedBy", sym)
            self.assertEqual(sym["citation"], f"a.py#L{sym['line']}")

    def test_unsupported_extension_falls_back_to_regex(self) -> None:
        symbols = extracted_symbols("???invalid!!!", "weird.xyz")
        # Possibly empty, but every returned dict must be tagged as fallback.
        self.assertTrue(all(s.get("parsedBy") == "regex_fallback" for s in symbols))

    def test_parse_error_falls_back_without_exception(self) -> None:
        # Malformed C# (unsupported grammar) and malformed python both return
        # without raising; unsupported routes through the regex fallback.
        cs = extracted_symbols("class {{{ broken", "broken.cs")
        self.assertTrue(all(s.get("parsedBy") == "regex_fallback" for s in cs))
        py = extracted_symbols("def (:\n", "broken.py")  # malformed python
        self.assertIsInstance(py, list)


if __name__ == "__main__":
    unittest.main()

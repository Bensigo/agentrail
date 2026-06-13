from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from agentrail.context.index import build_index, extracted_symbols, symbol_aware_code_chunks
from agentrail.context.retrieval import query_context
from agentrail.context.sources import source_record_for_file
from agentrail.shared.fs import sha256_text


def make_repo() -> Path:
    root = Path(tempfile.mkdtemp())
    subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
    (root / ".agentrail").mkdir()
    (root / ".agentrail" / "config.json").write_text(json.dumps({
        "schemaVersion": 1,
        "context": {
            "includeGlobs": ["**/*"],
            "excludeGlobs": [".git/**", ".agentrail/context/**"],
            "maxFileSizeBytes": 262144,
            "skipBinary": True,
            "respectGitIgnore": True,
            "secretRedaction": {"enabled": False, "action": "exclude", "denyGlobs": []},
            "embedding": {"mode": "disabled", "provider": None, "model": None},
            "summary": {"mode": "disabled", "provider": None, "model": None},
        },
    }, indent=2), encoding="utf-8")
    (root / "lib").mkdir()
    # Defines settleInvoice once.
    (root / "lib" / "ledger.js").write_text(
        "function settleInvoice(id){\n  return id;\n}\nmodule.exports = { settleInvoice };\n",
        encoding="utf-8")
    # Calls settleInvoice many times (would win on raw BM25).
    (root / "lib" / "worker.js").write_text(
        "settleInvoice(1); settleInvoice(2); settleInvoice(3); settleInvoice(4);\n",
        encoding="utf-8")
    return root


class SymbolDefinitionRankingTests(unittest.TestCase):
    def test_defining_file_outranks_caller(self) -> None:
        root = make_repo()
        build_index(root)
        out = query_context(root, "settleInvoice", limit=6)
        paths = [r["path"] for r in out["results"]]
        self.assertIn("lib/ledger.js", paths)
        self.assertLess(
            paths.index("lib/ledger.js"),
            paths.index("lib/worker.js"),
            f"defining file should rank above caller; got order {paths}",
        )

    def test_definition_outranks_dense_reference_files(self) -> None:
        # Mirrors Express: many short test/usage files densely repeat the symbol
        # (high BM25) and would otherwise bury the single definition site.
        root = make_repo()
        # Long definition file (BM25 diluted by length, like Express's response.js)
        filler = "\n".join(f"function other_{n}(){{ return {n}; }}" for n in range(120))
        (root / "lib" / "ledger.js").write_text(
            f"function settleInvoice(id){{ return id; }}\n{filler}\nmodule.exports = {{ settleInvoice }};\n",
            encoding="utf-8")
        # Short reference files densely repeating the symbol (high BM25, like tests)
        for i in range(6):
            (root / "lib" / f"usage_{i}.js").write_text(
                " ".join(["settleInvoice();"] * 12) + "\n", encoding="utf-8")
        build_index(root)
        out = query_context(root, "settleInvoice", limit=10)
        paths = [r["path"] for r in out["results"]]
        self.assertEqual(paths[0], "lib/ledger.js",
                         f"definition site must rank #1 over dense reference files; got {paths[:4]}")

    def test_dotted_member_definition_outranks_callers_and_namesakes(self) -> None:
        # "res.json" must rank the file assigning res.json, above dense callers
        # AND above a file that defines an unrelated same-named member (express.json).
        root = make_repo()
        (root / "lib" / "response.js").write_text(
            "var res = {};\nres.json = function json(obj){ return JSON.stringify(obj); };\n", encoding="utf-8")
        (root / "lib" / "express_json.js").write_text(
            "exports.json = function json(opts){ return middleware; };\n" * 4, encoding="utf-8")
        for i in range(5):
            (root / "lib" / f"caller_{i}.js").write_text(
                " ".join(["res.json({});"] * 10) + "\n", encoding="utf-8")
        build_index(root)
        out = query_context(root, "res.json", limit=10)
        paths = [r["path"] for r in out["results"]]
        self.assertEqual(paths[0], "lib/response.js",
                         f"dotted-member definition must rank #1; got {paths[:4]}")

    def test_definition_reason_recorded(self) -> None:
        root = make_repo()
        build_index(root)
        out = query_context(root, "settleInvoice", limit=6)
        top = next(r for r in out["results"] if r["path"] == "lib/ledger.js")
        self.assertIn("symbol definition", top["reason"])


class TreeSitterExtractionTests(unittest.TestCase):
    """AC3: at least two symbols (function + class/struct) per supported language."""

    def _syms(self, src: str, path: str):
        return extracted_symbols(src, path)

    def _assert_sym(self, syms, name: str, kind: str, line: int):
        match = next((s for s in syms if s["name"] == name), None)
        self.assertIsNotNone(match, f"symbol '{name}' not found in {syms}")
        self.assertEqual(match["kind"], kind, f"wrong kind for '{name}'")
        self.assertEqual(match["line"], line, f"wrong line for '{name}'")
        self.assertTrue(match["deterministic"])
        self.assertNotIn("parsedBy", match)

    # Python
    def test_python(self):
        src = "def foo():\n    pass\n\nclass Bar:\n    pass\n"
        syms = self._syms(src, "test.py")
        self._assert_sym(syms, "foo", "function", 1)
        self._assert_sym(syms, "Bar", "class", 4)

    # JavaScript
    def test_javascript(self):
        src = "function foo() {}\nclass Bar {}\n"
        syms = self._syms(src, "test.js")
        self._assert_sym(syms, "foo", "function", 1)
        self._assert_sym(syms, "Bar", "class", 2)

    # JSX
    def test_jsx(self):
        src = "function App() { return null; }\nclass Widget {}\n"
        syms = self._syms(src, "test.jsx")
        self._assert_sym(syms, "App", "function", 1)
        self._assert_sym(syms, "Widget", "class", 2)

    # TypeScript
    def test_typescript(self):
        src = "function foo(): void {}\nclass Bar {}\n"
        syms = self._syms(src, "test.ts")
        self._assert_sym(syms, "foo", "function", 1)
        self._assert_sym(syms, "Bar", "class", 2)

    # TSX
    def test_tsx(self):
        src = "function App(): null { return null; }\nclass Widget {}\n"
        syms = self._syms(src, "test.tsx")
        self._assert_sym(syms, "App", "function", 1)
        self._assert_sym(syms, "Widget", "class", 2)

    # Go
    def test_go(self):
        src = "package main\nfunc Foo() {}\ntype Bar struct {}\n"
        syms = self._syms(src, "test.go")
        self._assert_sym(syms, "Foo", "function", 2)
        self._assert_sym(syms, "Bar", "struct", 3)

    # Rust
    def test_rust(self):
        src = "fn foo() {}\nstruct Bar {}\n"
        syms = self._syms(src, "test.rs")
        self._assert_sym(syms, "foo", "function", 1)
        self._assert_sym(syms, "Bar", "struct", 2)

    # Java
    def test_java(self):
        src = "public class Foo {\n    public void bar() {}\n}\n"
        syms = self._syms(src, "test.java")
        self._assert_sym(syms, "Foo", "class", 1)
        self._assert_sym(syms, "bar", "method", 2)

    # Kotlin
    def test_kotlin(self):
        src = "fun foo() {}\nclass Bar {}\n"
        syms = self._syms(src, "test.kt")
        self._assert_sym(syms, "foo", "function", 1)
        self._assert_sym(syms, "Bar", "class", 2)

    # Ruby
    def test_ruby(self):
        src = "def foo\nend\nclass Bar\nend\n"
        syms = self._syms(src, "test.rb")
        self._assert_sym(syms, "foo", "function", 1)
        self._assert_sym(syms, "Bar", "class", 3)

    # PHP
    def test_php(self):
        src = "<?php\nfunction foo() {}\nclass Bar {}\n"
        syms = self._syms(src, "test.php")
        self._assert_sym(syms, "foo", "function", 2)
        self._assert_sym(syms, "Bar", "class", 3)

    # C
    def test_c(self):
        src = "int foo(int x) { return x; }\nstruct Bar { int x; };\n"
        syms = self._syms(src, "test.c")
        self._assert_sym(syms, "foo", "function", 1)
        self._assert_sym(syms, "Bar", "struct", 2)

    # C header (function prototype + struct)
    def test_c_header(self):
        src = "void foo(void);\nstruct Bar { int x; };\n"
        syms = self._syms(src, "test.h")
        self._assert_sym(syms, "foo", "function", 1)
        self._assert_sym(syms, "Bar", "struct", 2)

    # C++
    def test_cpp(self):
        src = "void foo() {}\nclass Bar {};\n"
        syms = self._syms(src, "test.cpp")
        self._assert_sym(syms, "foo", "function", 1)
        self._assert_sym(syms, "Bar", "class", 2)

    # Bash / Shell
    def test_bash(self):
        src = "foo() { echo hi; }\nfunction bar() { echo bar; }\n"
        syms = self._syms(src, "test.sh")
        self._assert_sym(syms, "foo", "function", 1)
        self._assert_sym(syms, "bar", "function", 2)

    # AC2: unsupported extension → regex fallback (possibly empty), no exception
    def test_unsupported_extension_fallback(self):
        syms = self._syms("???invalid!!!", "test.xyz")
        self.assertTrue(all(s.get("parsedBy") == "regex_fallback" for s in syms) if syms else True)

    # AC2: grammar=None (.cs) → regex fallback, no exception
    def test_grammar_none_fallback(self):
        syms = self._syms("public class Foo {}", "test.cs")
        self.assertTrue(all(s.get("parsedBy") == "regex_fallback" for s in syms) if syms else True)

    # AC4: Python chunk boundaries identical before/after tree-sitter (same symbol+line)
    def test_python_chunk_boundaries_stable(self):
        root = Path(tempfile.mkdtemp())
        py_src = "import os\n\ndef alpha():\n    return 1\n\ndef beta():\n    return 2\n"
        full = root / "src.py"
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(py_src, encoding="utf-8")
        source = source_record_for_file(full, "src.py", content_hash=sha256_text(py_src), content=py_src)
        chunks = symbol_aware_code_chunks(source, py_src, "src.py")
        sym_chunks = [c for c in chunks if c.symbol]
        names = [c.symbol for c in sym_chunks]
        self.assertEqual(names, ["alpha", "beta"])
        lines = [c.startLine for c in sym_chunks]
        self.assertEqual(lines, [3, 6])

    # AC4: TypeScript chunk boundaries stable
    def test_typescript_chunk_boundaries_stable(self):
        root = Path(tempfile.mkdtemp())
        ts_src = "import { foo } from './foo';\n\nfunction alpha(): void {}\n\nfunction beta(): void {}\n"
        full = root / "src.ts"
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(ts_src, encoding="utf-8")
        source = source_record_for_file(full, "src.ts", content_hash=sha256_text(ts_src), content=ts_src)
        chunks = symbol_aware_code_chunks(source, ts_src, "src.ts")
        sym_chunks = [c for c in chunks if c.symbol]
        names = [c.symbol for c in sym_chunks]
        self.assertEqual(names, ["alpha", "beta"])
        lines = [c.startLine for c in sym_chunks]
        self.assertEqual(lines, [3, 5])


if __name__ == "__main__":
    unittest.main()

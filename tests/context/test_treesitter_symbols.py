"""AC3: Per-language tree-sitter symbol extraction fixtures.

Each test class covers one language from the 12 supported grammars.
Every fixture has at least one function and one class/struct — the minimum
needed to assert correct ``name``, ``kind``, and ``line`` values.

AC1 / schema: all returned dicts must have exactly the keys
  {name, kind, line, citation, deterministic} on the tree-sitter path
  (no ``parsedBy`` field).

AC2: unsupported extension and parse-error inputs fall back to regex with
  ``parsedBy: "regex_fallback"`` on every dict.
"""
from __future__ import annotations

import unittest

from agentrail.context.index import extracted_symbols

_SCHEMA_KEYS = {"name", "kind", "line", "citation", "deterministic"}


def _assert_schema(test: unittest.TestCase, syms: list, path: str) -> None:
    """Assert all symbols conform to the tree-sitter output schema."""
    for s in syms:
        test.assertEqual(
            set(s.keys()), _SCHEMA_KEYS,
            f"symbol {s!r} has wrong keys for path {path}",
        )
        test.assertTrue(s["deterministic"])
        test.assertIn(f"#L{s['line']}", s["citation"])


def _sym(syms: list, name: str) -> dict:
    """Return the first symbol with the given name."""
    return next((s for s in syms if s["name"] == name), {})


class TestPythonSymbols(unittest.TestCase):
    def test_function_and_class(self) -> None:
        src = "def my_func(x):\n    return x\n\nclass MyClass:\n    pass\n"
        syms = extracted_symbols(src, "example.py")
        _assert_schema(self, syms, "example.py")
        names = {s["name"] for s in syms}
        self.assertIn("my_func", names)
        self.assertIn("MyClass", names)
        self.assertEqual(_sym(syms, "my_func")["kind"], "function")
        self.assertEqual(_sym(syms, "my_func")["line"], 1)
        self.assertEqual(_sym(syms, "MyClass")["kind"], "class")
        self.assertEqual(_sym(syms, "MyClass")["line"], 4)

    def test_method_inside_class(self) -> None:
        src = "class Foo:\n    def bar(self):\n        pass\n"
        syms = extracted_symbols(src, "example.py")
        names = {s["name"] for s in syms}
        self.assertIn("bar", names)
        self.assertEqual(_sym(syms, "bar")["kind"], "method")


class TestJavaScriptSymbols(unittest.TestCase):
    def test_function_and_class(self) -> None:
        src = "function greet(name) { return name; }\nclass Greeter {\n  hi() {}\n}\n"
        syms = extracted_symbols(src, "app.js")
        _assert_schema(self, syms, "app.js")
        names = {s["name"] for s in syms}
        self.assertIn("greet", names)
        self.assertIn("Greeter", names)
        self.assertEqual(_sym(syms, "greet")["kind"], "function")
        self.assertEqual(_sym(syms, "greet")["line"], 1)
        self.assertEqual(_sym(syms, "Greeter")["kind"], "class")

    def test_arrow_function_const(self) -> None:
        src = "const add = (a, b) => a + b;\n"
        syms = extracted_symbols(src, "utils.js")
        names = {s["name"] for s in syms}
        self.assertIn("add", names)
        self.assertEqual(_sym(syms, "add")["kind"], "function")

    def test_method_in_class(self) -> None:
        src = "class Foo {\n  bar() {}\n}\n"
        syms = extracted_symbols(src, "foo.js")
        names = {s["name"] for s in syms}
        self.assertIn("bar", names)
        self.assertEqual(_sym(syms, "bar")["kind"], "method")


class TestTypeScriptSymbols(unittest.TestCase):
    def test_function_and_class(self) -> None:
        src = "function add(a: number): number { return a; }\nclass Counter {}\n"
        syms = extracted_symbols(src, "counter.ts")
        _assert_schema(self, syms, "counter.ts")
        names = {s["name"] for s in syms}
        self.assertIn("add", names)
        self.assertIn("Counter", names)
        self.assertEqual(_sym(syms, "add")["kind"], "function")
        self.assertEqual(_sym(syms, "Counter")["kind"], "class")

    def test_interface_and_type(self) -> None:
        src = "interface IUser { name: string; }\ntype UserId = number;\n"
        syms = extracted_symbols(src, "types.ts")
        names = {s["name"] for s in syms}
        self.assertIn("IUser", names)
        self.assertIn("UserId", names)
        self.assertEqual(_sym(syms, "IUser")["kind"], "interface")
        self.assertEqual(_sym(syms, "UserId")["kind"], "type")

    def test_enum(self) -> None:
        src = "enum Direction { Up, Down }\n"
        syms = extracted_symbols(src, "dir.ts")
        names = {s["name"] for s in syms}
        self.assertIn("Direction", names)
        self.assertEqual(_sym(syms, "Direction")["kind"], "enum")


class TestTSXSymbols(unittest.TestCase):
    def test_function_and_class(self) -> None:
        src = "function App(): JSX.Element { return <div/>; }\nclass Widget {}\n"
        syms = extracted_symbols(src, "App.tsx")
        _assert_schema(self, syms, "App.tsx")
        names = {s["name"] for s in syms}
        self.assertIn("App", names)
        self.assertIn("Widget", names)
        self.assertEqual(_sym(syms, "App")["kind"], "function")
        self.assertEqual(_sym(syms, "Widget")["kind"], "class")


class TestGoSymbols(unittest.TestCase):
    def test_function_and_struct(self) -> None:
        src = "package main\n\nfunc Run() {}\n\ntype Server struct{ port int }\n"
        syms = extracted_symbols(src, "main.go")
        _assert_schema(self, syms, "main.go")
        names = {s["name"] for s in syms}
        self.assertIn("Run", names)
        self.assertIn("Server", names)
        self.assertEqual(_sym(syms, "Run")["kind"], "function")
        self.assertEqual(_sym(syms, "Server")["kind"], "struct")
        self.assertEqual(_sym(syms, "Run")["line"], 3)
        self.assertEqual(_sym(syms, "Server")["line"], 5)

    def test_interface(self) -> None:
        src = "package main\n\ntype Reader interface{ Read() string }\n"
        syms = extracted_symbols(src, "iface.go")
        names = {s["name"] for s in syms}
        self.assertIn("Reader", names)


class TestRustSymbols(unittest.TestCase):
    def test_function_and_struct(self) -> None:
        src = "fn process() {}\nstruct Config { debug: bool }\n"
        syms = extracted_symbols(src, "lib.rs")
        _assert_schema(self, syms, "lib.rs")
        names = {s["name"] for s in syms}
        self.assertIn("process", names)
        self.assertIn("Config", names)
        self.assertEqual(_sym(syms, "process")["kind"], "function")
        self.assertEqual(_sym(syms, "Config")["kind"], "struct")
        self.assertEqual(_sym(syms, "process")["line"], 1)
        self.assertEqual(_sym(syms, "Config")["line"], 2)

    def test_enum_and_trait(self) -> None:
        src = "enum Status { Ok, Err }\ntrait Handler { fn handle(&self); }\n"
        syms = extracted_symbols(src, "traits.rs")
        names = {s["name"] for s in syms}
        self.assertIn("Status", names)
        self.assertIn("Handler", names)
        self.assertEqual(_sym(syms, "Status")["kind"], "enum")
        self.assertEqual(_sym(syms, "Handler")["kind"], "interface")


class TestJavaSymbols(unittest.TestCase):
    def test_class_and_method(self) -> None:
        src = "public class Service {\n    public void start() {}\n}\n"
        syms = extracted_symbols(src, "Service.java")
        _assert_schema(self, syms, "Service.java")
        names = {s["name"] for s in syms}
        self.assertIn("Service", names)
        self.assertIn("start", names)
        self.assertEqual(_sym(syms, "Service")["kind"], "class")
        self.assertEqual(_sym(syms, "start")["kind"], "method")
        self.assertEqual(_sym(syms, "Service")["line"], 1)

    def test_interface(self) -> None:
        src = "interface Runnable { void run(); }\n"
        syms = extracted_symbols(src, "Runnable.java")
        names = {s["name"] for s in syms}
        self.assertIn("Runnable", names)
        self.assertEqual(_sym(syms, "Runnable")["kind"], "interface")


class TestKotlinSymbols(unittest.TestCase):
    def test_function_and_class(self) -> None:
        src = "fun greet(): String = \"hello\"\nclass Greeter {\n    fun hello() {}\n}\n"
        syms = extracted_symbols(src, "Greeter.kt")
        _assert_schema(self, syms, "Greeter.kt")
        names = {s["name"] for s in syms}
        self.assertIn("greet", names)
        self.assertIn("Greeter", names)
        self.assertEqual(_sym(syms, "greet")["kind"], "function")
        self.assertEqual(_sym(syms, "Greeter")["kind"], "class")
        self.assertEqual(_sym(syms, "greet")["line"], 1)
        self.assertEqual(_sym(syms, "Greeter")["line"], 2)


class TestRubySymbols(unittest.TestCase):
    def test_method_and_class(self) -> None:
        src = "def greet\n  'hello'\nend\nclass Greeter\n  def hi\n  end\nend\n"
        syms = extracted_symbols(src, "greeter.rb")
        _assert_schema(self, syms, "greeter.rb")
        names = {s["name"] for s in syms}
        self.assertIn("greet", names)
        self.assertIn("Greeter", names)
        self.assertEqual(_sym(syms, "greet")["kind"], "function")
        self.assertEqual(_sym(syms, "greet")["line"], 1)
        self.assertEqual(_sym(syms, "Greeter")["kind"], "class")
        self.assertEqual(_sym(syms, "Greeter")["line"], 4)


class TestPHPSymbols(unittest.TestCase):
    def test_function_and_class(self) -> None:
        src = "<?php\nfunction compute() { return 1; }\nclass Calculator {\n    function add($a) {}\n}\n"
        syms = extracted_symbols(src, "calc.php")
        _assert_schema(self, syms, "calc.php")
        names = {s["name"] for s in syms}
        self.assertIn("compute", names)
        self.assertIn("Calculator", names)
        self.assertEqual(_sym(syms, "compute")["kind"], "function")
        self.assertEqual(_sym(syms, "Calculator")["kind"], "class")
        self.assertEqual(_sym(syms, "compute")["line"], 2)
        self.assertEqual(_sym(syms, "Calculator")["line"], 3)


class TestCSymbols(unittest.TestCase):
    def test_function_and_struct(self) -> None:
        src = "int add(int a, int b) { return a + b; }\ntypedef struct Point { int x; int y; } Point;\n"
        syms = extracted_symbols(src, "math.c")
        _assert_schema(self, syms, "math.c")
        names = {s["name"] for s in syms}
        self.assertIn("add", names)
        self.assertIn("Point", names)
        self.assertEqual(_sym(syms, "add")["kind"], "function")
        self.assertEqual(_sym(syms, "add")["line"], 1)

    def test_c_header(self) -> None:
        src = "int compute(int x);\nstruct Config { int debug; };\n"
        syms = extracted_symbols(src, "api.h")
        # .h files may have function declarations (no body) — tree-sitter may not
        # capture these as function_definition. Just assert no exception and struct found.
        names = {s["name"] for s in syms}
        self.assertIn("Config", names)


class TestCppSymbols(unittest.TestCase):
    def test_function_and_class(self) -> None:
        src = "int add(int a, int b) { return a + b; }\nclass Vector {\n    void push(int x) {}\n};\n"
        syms = extracted_symbols(src, "vector.cpp")
        _assert_schema(self, syms, "vector.cpp")
        names = {s["name"] for s in syms}
        self.assertIn("add", names)
        self.assertIn("Vector", names)
        self.assertEqual(_sym(syms, "add")["kind"], "function")
        self.assertEqual(_sym(syms, "Vector")["kind"], "class")
        self.assertEqual(_sym(syms, "add")["line"], 1)
        self.assertEqual(_sym(syms, "Vector")["line"], 2)


class TestBashSymbols(unittest.TestCase):
    def test_two_functions(self) -> None:
        src = "setup() {\n  echo 'setup'\n}\nfunction teardown() {\n  echo 'done'\n}\n"
        syms = extracted_symbols(src, "run.sh")
        _assert_schema(self, syms, "run.sh")
        names = {s["name"] for s in syms}
        self.assertIn("setup", names)
        self.assertIn("teardown", names)
        self.assertEqual(_sym(syms, "setup")["kind"], "function")
        self.assertEqual(_sym(syms, "setup")["line"], 1)
        self.assertEqual(_sym(syms, "teardown")["kind"], "function")
        self.assertEqual(_sym(syms, "teardown")["line"], 4)


class TestFallbackBehaviour(unittest.TestCase):
    """AC2: unsupported extension and parse errors fall back to regex."""

    def test_unsupported_extension_returns_regex_fallback(self) -> None:
        syms = extracted_symbols("???invalid!!!", "test.xyz")
        # Either empty (regex found nothing) or all have parsedBy=regex_fallback
        self.assertTrue(
            all(s.get("parsedBy") == "regex_fallback" for s in syms) if syms else True
        )

    def test_malformed_python_falls_back(self) -> None:
        # has_error → regex fallback
        syms = extracted_symbols("def ???(): pass", "broken.py")
        self.assertTrue(
            all(s.get("parsedBy") == "regex_fallback" for s in syms) if syms else True
        )

    def test_no_exception_on_malformed_source(self) -> None:
        # Must not raise
        try:
            extracted_symbols("}{]{][", "test.js")
        except Exception as exc:
            self.fail(f"extracted_symbols raised {exc!r} on malformed input")

    def test_tree_sitter_path_omits_parsed_by(self) -> None:
        syms = extracted_symbols("def foo(): pass\n", "ok.py")
        self.assertTrue(syms, "expected at least one symbol")
        for s in syms:
            self.assertNotIn("parsedBy", s)


if __name__ == "__main__":
    unittest.main()

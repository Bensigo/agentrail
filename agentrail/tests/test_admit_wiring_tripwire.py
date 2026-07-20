"""Structural tripwire (#1348): every production ``admit()`` call site must be
either the known in-memory-only seam or routed through ``release_if_aligned``.

Context (verify against ``agentrail/afk/queue_state.py`` if this ever needs
updating): ``queue_state.release_if_aligned`` is the alignment-aware release
gate — the Python mirror of the TypeScript ``unparkDependents`` — and it is the
ONLY sanctioned way to re-admit a row that might already be PERSISTED and
PARKED. A bare call to ``queue_state.admit()`` against such a row would flip it
straight back to QUEUED/claimable WITHOUT re-checking alignment, silently
reopening the exact bypass class #1274 PR③ closed on the TypeScript side.

Today ``release_if_aligned`` is deliberately UNWIRED: a prior adversarial
review traced every Python caller of ``admit()`` and confirmed none of them can
currently flip a persisted PARKED row to QUEUED (see the allowlist below, and
``release_if_aligned``'s own NOTE docstring paragraph). The only guard against
a FUTURE caller reintroducing that bypass was a docstring + code adjacency —
exactly the kind of soft guard that let the TS-side bypass happen before this
module existed. This test is the mechanical replacement: it greps (via
``ast``, not text-matching) every production module for a call to
``queue_state.admit`` and fails loudly, with a fix pointer, for anything not on
the explicit allowlist below.

This is a *structural* test — it has no opinion on runtime behavior, so it
cannot accidentally break a legitimate call path (Option B, a runtime guard
inside ``admit()`` itself, was considered and rejected for exactly that
blast-radius reason — a bad guard could break a real, legitimate call site;
this static Option A test cannot).

Scope: every ``.py`` file under ``agentrail/`` EXCEPT ``agentrail/tests/`` and
``agentrail/evals/`` (eval corpus fixtures/answer-keys, not shipped code) — the
same "production Python modules" scope the issue describes.
"""
from __future__ import annotations

import ast
from pathlib import Path
from typing import Dict, List, NamedTuple, Set, Tuple

# ``agentrail/tests/test_admit_wiring_tripwire.py`` -> parents[0]=tests,
# parents[1]=agentrail, parents[2]=repo root.
_THIS_FILE = Path(__file__).resolve()
_AGENTRAIL_ROOT = _THIS_FILE.parents[1]
_REPO_ROOT = _THIS_FILE.parents[2]

# Directories under agentrail/ that are NOT production code: test suites and
# the eval harness's corpus (fixture issues + their answer-key tests, which
# exercise ``admit()`` directly on purpose as test code, not a live caller).
_EXCLUDED_DIR_PARTS = {"tests", "evals", "__pycache__"}

_QUEUE_STATE_MODULE = "agentrail.afk.queue_state"
_QUEUE_STATE_FILE = "agentrail/afk/queue_state.py"


class AdmitCall(NamedTuple):
    """One located call to ``queue_state.admit`` in a production module."""

    file: str    # path relative to repo root, e.g. "agentrail/afk/queue_store.py"
    line: int
    qualname: str  # "ClassName.method_name", "function_name", or "<module>"


# --- the allowlist: every known-safe production admit() call site today -----
#
# Keyed by (relative file path, enclosing qualname). Each entry is REQUIRED to
# actually be found by the scan below (an unused entry fails just as loudly as
# an unlisted call site — the allowlist cannot silently rot to cover code that
# no longer exists).
_ALLOWLIST: Dict[Tuple[str, str], str] = {
    (_QUEUE_STATE_FILE, "release_if_aligned"): (
        "the alignment-release gate itself calling the pure decision function "
        "it wraps — this IS the sanctioned path (release_if_aligned re-admits "
        "via admit() and THEN applies the alignment overlay), not a bypass of it"
    ),
    ("agentrail/afk/queue_store.py", "QueueStore.enqueue"): (
        "admits a FRESHLY-MINTED entry (from input_contract.admit_to_queue) "
        "BEFORE its first insert, which is ON CONFLICT DO NOTHING — this never "
        "re-admits an existing persisted row, so there is no PARKED row here "
        "for admit() to wrongly release (verified: queue_store.py's own "
        "comment on the release_if_aligned import explicitly documents that "
        "no live Python re-admit path exists yet)"
    ),
    ("agentrail/heartbeat/dispatcher.py", "Dispatcher.enqueue"): (
        "admits a freshly-minted entry into Dispatcher's in-memory `self.queue` "
        "list before it is ever appended — same freshly-minted-entry shape as "
        "QueueStore.enqueue, and Dispatcher has no database-backed persistence "
        "at all (its queue lives only in process memory)"
    ),
    ("agentrail/heartbeat/dispatcher.py", "Dispatcher.readmit"): (
        "re-admits Dispatcher's in-memory `self.queue` entries, but Dispatcher "
        "has ZERO production constructors today — every `Dispatcher(...)` call "
        "site in the repo is in a test file (agentrail/tests/heartbeat/). "
        "It therefore never touches a persisted PARKED row. THE DAY Dispatcher "
        "gains a live/production constructor, this call site must be "
        "re-justified (does it ever run against a persisted row?) or migrated "
        "to release_if_aligned — do not just carry this entry forward unread"
    ),
}


def _iter_production_py_files() -> List[Path]:
    files = []
    for path in _AGENTRAIL_ROOT.rglob("*.py"):
        rel_parts = path.relative_to(_AGENTRAIL_ROOT).parts
        if _EXCLUDED_DIR_PARTS & set(rel_parts[:-1]):
            continue
        files.append(path)
    return files


class _AdmitCallVisitor(ast.NodeVisitor):
    """Finds calls to the bound names/aliases that resolve to
    ``queue_state.admit`` inside one module, tagged with their enclosing
    function/class (a plain function-local ``ast`` walk with a manual
    class/function stack — ``ast`` gives no parent pointers by default).
    """

    def __init__(self, admit_names: Set[str], module_aliases: Set[str]):
        self.admit_names = admit_names
        self.module_aliases = module_aliases
        self._class_stack: List[str] = []
        self._func_stack: List[str] = []
        self.found: List[Tuple[int, str]] = []

    def _qualname(self) -> str:
        # Code-review finding (fixed): joining only the INNERMOST class/func
        # frame let two structurally different call sites in the same file
        # collapse to the same allowlist key whenever their innermost names
        # happened to match (e.g. two different classes each defining a
        # method named "enqueue") — a false-negative risk for exactly the
        # kind of sneaky future bypass this test exists to catch. Joining the
        # FULL nesting stack disambiguates that. No behavior change for
        # today's real call sites, which are all single-level (a top-level
        # class's own method, or a bare top-level function).
        parts = [*self._class_stack, *self._func_stack]
        return ".".join(parts) if parts else "<module>"

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self._class_stack.append(node.name)
        self.generic_visit(node)
        self._class_stack.pop()

    def _visit_func(self, node) -> None:
        self._func_stack.append(node.name)
        self.generic_visit(node)
        self._func_stack.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._visit_func(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._visit_func(node)

    def visit_Call(self, node: ast.Call) -> None:
        func = node.func
        is_target = False
        if isinstance(func, ast.Name) and func.id in self.admit_names:
            is_target = True
        elif (
            isinstance(func, ast.Attribute)
            and func.attr == "admit"
            and isinstance(func.value, ast.Name)
            and func.value.id in self.module_aliases
        ):
            is_target = True
        if is_target:
            self.found.append((node.lineno, self._qualname()))
        self.generic_visit(node)


def _bound_admit_names(tree: ast.AST, *, is_queue_state_module: bool) -> Tuple[Set[str], Set[str]]:
    """Names in this module bound to ``queue_state.admit`` (direct import,
    possibly aliased) and module aliases bound to ``agentrail.afk.queue_state``
    itself (for ``alias.admit(...)`` call sites). Scans the WHOLE tree, not
    just the top level — this codebase uses function-local imports too (see
    ``QueueStore.transition``'s local ``from agentrail.afk import
    queue_state``).
    """
    admit_names: Set[str] = set()
    module_aliases: Set[str] = set()
    if is_queue_state_module:
        # queue_state.py defines admit() locally; a bare `admit(...)` call
        # inside it (e.g. release_if_aligned's own call) refers to that
        # definition without any import at all.
        admit_names.add("admit")
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == _QUEUE_STATE_MODULE:
            for alias in node.names:
                if alias.name == "admit":
                    admit_names.add(alias.asname or alias.name)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == _QUEUE_STATE_MODULE:
                    module_aliases.add(alias.asname or alias.name.rsplit(".", 1)[-1])
        elif isinstance(node, ast.ImportFrom) and node.module == "agentrail.afk":
            for alias in node.names:
                if alias.name == "queue_state":
                    module_aliases.add(alias.asname or alias.name)
    return admit_names, module_aliases


def _scan() -> List[AdmitCall]:
    calls: List[AdmitCall] = []
    for py_file in _iter_production_py_files():
        source = py_file.read_text(encoding="utf-8")
        if "admit" not in source:
            continue  # cheap skip before paying for a parse
        tree = ast.parse(source, filename=str(py_file))
        rel = py_file.relative_to(_REPO_ROOT).as_posix()
        is_queue_state_module = rel == _QUEUE_STATE_FILE
        admit_names, module_aliases = _bound_admit_names(
            tree, is_queue_state_module=is_queue_state_module
        )
        if not admit_names and not module_aliases:
            continue
        visitor = _AdmitCallVisitor(admit_names, module_aliases)
        visitor.visit(tree)
        for line, qualname in visitor.found:
            calls.append(AdmitCall(file=rel, line=line, qualname=qualname))
    return calls


def test_every_admit_call_site_is_allowlisted_or_goes_through_release_gate():
    """AC1 (#1348): a new, unlisted ``admit()`` caller fails CI loudly.

    Every call to ``agentrail.afk.queue_state.admit`` found in production code
    must be a key in ``_ALLOWLIST`` above. This is not a rubber stamp: each
    allowlist entry documents WHY that specific call site can never observe a
    persisted PARKED row. A caller that CAN observe one must route through
    ``agentrail.afk.queue_state.release_if_aligned`` instead.
    """
    found = _scan()
    observed_keys = {(c.file, c.qualname) for c in found}

    violations = [c for c in found if (c.file, c.qualname) not in _ALLOWLIST]
    if violations:
        listing = "\n".join(f"  {c.file}:{c.line} in {c.qualname}()" for c in violations)
        pytest_fail_message = (
            "New admit() caller(s) found outside the allowlist in this test "
            f"({_THIS_FILE.relative_to(_REPO_ROOT)}):\n"
            f"{listing}\n\n"
            "agentrail.afk.queue_state.admit() must never be called directly "
            "against a row that might already be PERSISTED and PARKED — a bare "
            "admit() silently skips the alignment gate and can flip a parked "
            "row straight to QUEUED/claimable without a sanctioned budget "
            "(estimated_budget_usd). If this caller can ever observe a "
            "persisted PARKED entry, route it through "
            "agentrail.afk.queue_state.release_if_aligned(entry, "
            "open_blockers, aligned=...) instead — see that function's "
            "docstring in agentrail/afk/queue_state.py. If this call site is "
            "genuinely safe (e.g. it only ever admits a freshly-minted, "
            "never-persisted entry), add it to _ALLOWLIST in this test file "
            "with a justification comment explaining why, the same way the "
            "existing entries are documented."
        )
        raise AssertionError(pytest_fail_message)

    unused = set(_ALLOWLIST) - observed_keys
    assert not unused, (
        "Stale _ALLOWLIST entries no longer found by the scan (the call site "
        "moved or was removed) — update or delete them so the allowlist keeps "
        f"describing real code: {sorted(unused)}"
    )

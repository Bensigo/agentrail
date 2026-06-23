"""AC4: NO guardrail policy module imports a framework / environment I/O lib.

Scans EVERY module under ``agentrail.guardrails.policies`` (not just one) and
asserts none of them import ``subprocess``/``gh``/``git``/``pytest`` (or other
network/IO libs).  That I/O lives only under ``agentrail.guardrails.adapters``.

This generalises #918's single-module purity check to the whole policies package
so a future policy (#921) that reaches for ``subprocess`` is caught immediately.
"""
from __future__ import annotations

import ast
import importlib
import inspect
import pkgutil

import agentrail.guardrails.adapters as adapters_pkg
import agentrail.guardrails.policies as policies_pkg

_FORBIDDEN = {"subprocess", "urllib", "socket", "requests", "pytest", "http", "git", "gh"}


def _imported_top_levels(module) -> set[str]:
    tree = ast.parse(inspect.getsource(module))
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])
    return imported


def _policy_modules():
    return [
        importlib.import_module(f"{policies_pkg.__name__}.{m.name}")
        for m in pkgutil.iter_modules(policies_pkg.__path__)
    ]


def test_found_some_policy_modules():
    # Guard the scan: if discovery silently returns nothing the asserts below pass
    # vacuously. There must be at least the output_enforcer + proof_required.
    names = {m.__name__.rsplit(".", 1)[-1] for m in _policy_modules()}
    assert {"output_enforcer", "proof_required"} <= names


def test_no_policy_imports_io_or_framework():
    for module in _policy_modules():
        imported = _imported_top_levels(module)
        leaked = imported & _FORBIDDEN
        assert not leaked, f"{module.__name__} imports forbidden I/O: {sorted(leaked)}"
        # Must not import the adapters package either — policies read Signals only.
        assert "agentrail.guardrails.adapters" not in {
            node.module
            for node in ast.walk(ast.parse(inspect.getsource(module)))
            if isinstance(node, ast.ImportFrom) and node.module
        }, f"{module.__name__} must not import the adapters layer"


def test_adapters_are_the_io_boundary():
    # Sanity that the seam exists: the git adapter is where subprocess lives.
    git_mod = importlib.import_module(f"{adapters_pkg.__name__}.git")
    assert "subprocess" in _imported_top_levels(git_mod)

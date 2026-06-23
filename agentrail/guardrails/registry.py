"""Guardrail registry — the discoverable seam every policy registers into.

A policy registers itself once, at import time, via :func:`register` (used as a
decorator on the guardrail instance's factory, or called explicitly).  Tooling
then enumerates everything through :func:`list_guardrails` without executing any
policy.

Why this shape (foundation for #919–#922)
-----------------------------------------
* Registration is *explicit* (an ``@register`` decorator / ``register()`` call),
  not magic auto-discovery, so the set of guardrails is deterministic and import
  order does not silently drop one.  ``agentrail.guardrails.policies`` imports
  each policy module so simply importing the package populates the registry.
* The registry stores :class:`~agentrail.guardrails.base.Guardrail` instances
  keyed by ``name``.  ``list_guardrails()`` returns them sorted by name so docs
  (#922) render deterministically.
* No I/O, no framework imports — registration is pure bookkeeping.  As #921
  migrates more policies in, each just decorates its instance; nothing here
  changes.
"""
from __future__ import annotations

from typing import Callable, TypeVar

from agentrail.guardrails.base import Guardrail

# name -> guardrail instance
_REGISTRY: dict[str, Guardrail] = {}

G = TypeVar("G", bound=Guardrail)


def register(guardrail: G) -> G:
    """Register a guardrail instance and return it (usable as a decorator).

    Raises ``ValueError`` on a duplicate ``name`` so two policies cannot silently
    shadow each other.
    """
    name = guardrail.name
    if not name:
        raise ValueError("guardrail must have a non-empty name")
    if name in _REGISTRY and _REGISTRY[name] is not guardrail:
        raise ValueError(f"guardrail name already registered: {name!r}")
    _REGISTRY[name] = guardrail
    return guardrail


def get_guardrail(name: str) -> Guardrail:
    """Return the registered guardrail named *name* (``KeyError`` if absent)."""
    return _REGISTRY[name]


def list_guardrails() -> list[Guardrail]:
    """Return every registered guardrail, sorted by ``name`` (deterministic)."""
    return [_REGISTRY[k] for k in sorted(_REGISTRY)]


def _clear_for_tests() -> None:  # pragma: no cover - test hook only
    """Reset the registry. Intended for tests that exercise registration."""
    _REGISTRY.clear()


# Decorator-friendly alias: a factory returning a Guardrail can be wrapped, but
# the common path is `register(SomePolicy(...))`.  Kept as a named export so #922
# / future call sites can import a single, obvious symbol.
def registered(factory: Callable[[], G]) -> G:
    """Call *factory*, register the result, and return it."""
    return register(factory())

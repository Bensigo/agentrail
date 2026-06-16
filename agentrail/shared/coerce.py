"""Type-coercion helpers for agentrail."""
from __future__ import annotations

_TRUTHY = {"true", "1", "yes"}


def to_bool(s: str) -> bool:
    """Return True for 'true'/'1'/'yes' (case-insensitive), else False."""
    return s.strip().lower() in _TRUTHY

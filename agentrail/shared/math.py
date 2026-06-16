from __future__ import annotations

from typing import TypeVar

_T = TypeVar("_T", int, float)


def clamp(value: _T, low: _T, high: _T) -> _T:
    """Return value clamped to [low, high]."""
    if value < low:
        return low
    if value > high:
        return high
    return value

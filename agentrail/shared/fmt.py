"""Formatting helpers shared across the agentrail package."""
from __future__ import annotations


def format_duration(seconds: int) -> str:
    """Return a short human-readable string for a duration in seconds.

    Examples::

        >>> format_duration(0)
        '0s'
        >>> format_duration(5)
        '5s'
        >>> format_duration(90)
        '1m 30s'
        >>> format_duration(3661)
        '1h 1m 1s'
    """
    h, remainder = divmod(seconds, 3600)
    m, s = divmod(remainder, 60)
    parts = []
    if h:
        parts.append(f"{h}h")
    if m:
        parts.append(f"{m}m")
    if s or not parts:
        parts.append(f"{s}s")
    return " ".join(parts)

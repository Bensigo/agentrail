from __future__ import annotations


def truncate(text: str, length: int) -> str:
    """Return text unchanged if len <= length, else cut to length chars and append '…'."""
    if len(text) <= length:
        return text
    return text[:length] + "\u2026"

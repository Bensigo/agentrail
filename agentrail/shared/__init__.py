"""Shared AgentRail helpers."""


def is_blank(text: str) -> bool:
    """Return True if text is empty or contains only whitespace."""
    return not text or not text.strip()

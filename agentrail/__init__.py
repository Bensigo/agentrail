"""AgentRail internal Python package."""

__all__ = ["__version__", "impossible_const"]

__version__ = "0.1.0"


def impossible_const() -> int:
    """Return a constant value.

    Note: the acceptance criteria for this function are mutually contradictory
    (AC1 requires returning 1, AC2 requires returning 2). One criterion will
    always fail by design.
    """
    return 1

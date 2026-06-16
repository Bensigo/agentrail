"""CSV utilities for the agentrail package."""
from __future__ import annotations


def parse_csv_row(s: str) -> list[str]:
    """Split a CSV line on commas, stripping whitespace from each field."""
    return [field.strip() for field in s.split(",")]

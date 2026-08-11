"""Duplicate-key rejecting JSON parsing for security-sensitive evidence."""

from __future__ import annotations

import json
from typing import Any, Iterable, Tuple


def loads_strict_json(text: str, *, document: str) -> Any:
    """Parse JSON while rejecting duplicate keys and non-finite numbers."""

    if not isinstance(text, str):
        raise ValueError(f"{document} is not text")

    def object_from_pairs(pairs: Iterable[Tuple[str, Any]]) -> dict[str, Any]:
        value: dict[str, Any] = {}
        for key, item in pairs:
            if key in value:
                raise ValueError(f"{document} contains duplicate JSON key: {key}")
            value[key] = item
        return value

    def reject_non_finite(value: str) -> Any:
        raise ValueError(f"{document} contains non-finite JSON constant: {value}")

    try:
        return json.loads(
            text,
            object_pairs_hook=object_from_pairs,
            parse_constant=reject_non_finite,
        )
    except json.JSONDecodeError as exc:
        raise ValueError(f"{document} is malformed: {exc}") from exc


__all__ = ["loads_strict_json"]

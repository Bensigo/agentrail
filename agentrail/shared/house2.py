"""Shared House 2 (``.agentrail/`` layout) dual-path resolution helpers.

Per the repo-structure v2 design
(``docs/superpowers/specs/2026-07-08-repo-structure-v2-and-install-footprint-v2-design.md``,
decision D4), runtime readers must check the new ``.agentrail/``-rooted
install layout first, falling back to the pre-v2 legacy layout for one
release. The fallback exists only so installs performed before the v2
migration keep working; it is intentionally temporary and is expected to be
removed the release after ``agentrail upgrade`` (PR-6, #1137) ships a real
migration path.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional, Tuple, Union


def _present(path: Path, kind: str) -> bool:
    if kind == "file":
        return path.is_file()
    if kind == "dir":
        return path.is_dir()
    return path.exists()


def resolve_dual_path(
    target_dir: Union[Path, str],
    new_rel: str,
    legacy_rel: str,
    kind: str = "file",
) -> Tuple[Optional[Path], bool]:
    """Resolve a House-2-migrated path rooted at *target_dir*.

    Checks the new layout path (*new_rel*, e.g. ``".agentrail/context.md"``)
    first; if it is not present, falls back to the pre-v2 legacy path
    (*legacy_rel*, e.g. ``"CONTEXT.md"``).

    Returns a ``(resolved_path, used_legacy)`` tuple. ``resolved_path`` is
    ``None`` when neither path exists. ``used_legacy`` is ``True`` only when
    resolution fell back to *legacy_rel* — callers that want to surface a
    migration warning (D4's "doctor warning") key off this flag.
    """
    base = Path(target_dir)
    new_path = base / new_rel
    if _present(new_path, kind):
        return new_path, False
    legacy_path = base / legacy_rel
    if _present(legacy_path, kind):
        return legacy_path, True
    return None, False

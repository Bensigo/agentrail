"""Parse a JIT gather-phase CONTEXT MANIFEST into the file paths it selected.

Issue #1049 AC4, *precision half*. The gather subagent (see
:func:`agentrail.run.prompts.phase_prompt`, ``phase == "gather"``) ends its
free-text reply with a CONTEXT MANIFEST in this exact shape::

    CONTEXT MANIFEST
    Relevant files:
    - <path>:<start line>-<end line> — <why this range matters>
    Pinned symbols:
    - <path>:<line> — <exact symbol name / signature>
    Checked, not relevant:
    - checked <path or symbol> — not relevant because <reason>

This module extracts the paths the gatherer actually SELECTED — the union of
the "Relevant files:" and "Pinned symbols:" sections — so they can be scored
against a corpus task's ``requiredContext`` answer key with
:func:`agentrail.evals.pack_scorer.pack_precision_recall`. The "Checked, not
relevant:" section is the gatherer's *negatives* and is deliberately EXCLUDED:
those are paths it looked at and rejected, so counting them as picks would
punish exactly the ruling-out behaviour the phase is supposed to do.

Design rules (mirroring :mod:`agentrail.evals.pack_scorer`):

- **Pure, no IO.** String parsing only — no subprocess, filesystem, or network.
  Deterministic: same manifest text always yields the same path set.
- **Set of repo-relative paths.** Each entry's ``:<line-range>`` suffix and its
  ``— <why>`` trailer are stripped to a bare path; duplicates collapse, so the
  same file cited in both scored sections counts once.
- **Robust to a messy reply.** The gatherer writes free-text, so tolerate prose
  around the manifest, blank lines, markdown-bullet variants, backtick-wrapped
  paths, and em-dash / en-dash / hyphen trailer separators. If the exact
  ``CONTEXT MANIFEST`` marker is dropped, fall back to the first section header;
  if there is no manifest at all, return an empty set (which the scorer reads as
  precision ``None`` — undefined, never a fabricated ``0.0``).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import FrozenSet, List, Set

# Normalised section-header names (lower-cased, trailing ":" stripped).
_MARKER = "context manifest"
_RELEVANT = "relevant files"
_PINNED = "pinned symbols"
_CHECKED = "checked, not relevant"
# The two sections whose entries are the gatherer's SELECTED paths.
_SCORED_SECTIONS = frozenset({_RELEVANT, _PINNED})
# Every header we recognise, so an entry line is never mistaken for a header
# and a scored section stops at the next header (rather than bleeding into it).
_KNOWN_SECTIONS = frozenset({_RELEVANT, _PINNED, _CHECKED})

# A leading list bullet: "-", "*", or "•" followed by whitespace.
_BULLET = re.compile(r"^\s*[-*•]\s+")
# The separator between the "<path>:<lines>" head and the free-text trailer:
# an em dash (U+2014), en dash (U+2013), or one/two ASCII hyphens, with
# whitespace before it. The leading-whitespace requirement is what keeps an
# in-path hyphen ("agentrail/foo-bar.py") from being treated as a separator.
_TRAILER_SEP = re.compile(r"\s+(?:[—–]|-{1,2})(?:\s|$)")


@dataclass(frozen=True)
class ParsedManifest:
    """The paths a gather manifest selected, split by section.

    - ``relevant_files`` — bare repo-relative paths from "Relevant files:".
    - ``pinned_symbols`` — bare repo-relative paths from "Pinned symbols:".

    ``selected`` is their union — the set to score against ``requiredContext``.
    The "Checked, not relevant:" negatives are intentionally absent. Immutable so
    a parsed result cannot be mutated into a different set of picks.
    """

    relevant_files: FrozenSet[str]
    pinned_symbols: FrozenSet[str]

    @property
    def selected(self) -> FrozenSet[str]:
        """Union of both scored sections — the paths the gatherer picked."""
        return self.relevant_files | self.pinned_symbols


def parse_manifest(text: str) -> ParsedManifest:
    """Parse a gather manifest into its per-section selected paths.

    ``text`` is the gatherer's full reply (the manifest is expected at the end,
    possibly preceded by prose). Returns an empty :class:`ParsedManifest` when no
    manifest is present.
    """
    lines: List[str] = (text or "").splitlines()
    start = _manifest_start(lines)

    relevant: Set[str] = set()
    pinned: Set[str] = set()
    section: str = ""

    for line in lines[start:]:
        header = _header_name(line)
        if header in _KNOWN_SECTIONS:
            section = header
            continue
        if section in _SCORED_SECTIONS and line.strip():
            path = _path_from_entry(line)
            if path:
                (relevant if section == _RELEVANT else pinned).add(path)

    return ParsedManifest(frozenset(relevant), frozenset(pinned))


def parse_manifest_paths(text: str) -> Set[str]:
    """Return the union of the manifest's selected paths.

    Convenience wrapper over :func:`parse_manifest` — the set to pass straight to
    :func:`agentrail.evals.pack_scorer.pack_precision_recall` as ``cited_paths``.
    """
    return set(parse_manifest(text).selected)


def _manifest_start(lines: List[str]) -> int:
    """Index to start parsing at: just after the LAST ``CONTEXT MANIFEST`` line.

    Uses the last marker so prose that merely mentions the words earlier does not
    hijack parsing. If the marker was dropped from the reply, fall back to the
    first recognised section header. If neither exists there is no manifest —
    return ``len(lines)`` so the caller's slice is empty.
    """
    marker_idx = -1
    for i, line in enumerate(lines):
        if line.strip().lower() == _MARKER:
            marker_idx = i
    if marker_idx >= 0:
        return marker_idx + 1

    for i, line in enumerate(lines):
        if _header_name(line) in _KNOWN_SECTIONS:
            return i
    return len(lines)


def _header_name(line: str) -> str:
    """Normalise a line to a section-header key (lower-case, no trailing ":").

    Returns the normalised text regardless of whether it is a known header; the
    caller compares against ``_KNOWN_SECTIONS``.
    """
    return line.strip().rstrip(":").strip().lower()


def _path_from_entry(line: str) -> str:
    """Extract the bare repo-relative path from one manifest entry line.

    ``- agentrail/run/pipeline.py:301-340 — why`` -> ``agentrail/run/pipeline.py``.
    Strips the leading bullet, the ``— <trailer>`` free text, surrounding
    backticks, a ``:<line-range>`` suffix, and a leading ``./``. Returns ``""``
    when nothing path-like remains.
    """
    entry = _BULLET.sub("", line).strip()
    if not entry:
        return ""

    # Drop the free-text trailer ("— why this matters"), keeping the head. Only
    # the head holds the path, so a stray ":" or "-" in the prose can't confuse
    # the suffix stripping below.
    sep = _TRAILER_SEP.search(entry)
    head = entry[: sep.start()] if sep else entry
    head = head.replace("`", "").strip()

    # Strip the ":<line>" / ":<start>-<end>" suffix, then a leading "./".
    path = head.split(":", 1)[0].strip()
    if path.startswith("./"):
        path = path[2:]
    return path

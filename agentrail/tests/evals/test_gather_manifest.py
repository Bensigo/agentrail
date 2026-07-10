"""Tests for the gather-manifest path parser (#1049 AC4, precision half).

The parser reads a JIT gather phase's free-text CONTEXT MANIFEST and returns the
paths the gatherer SELECTED — the union of the "Relevant files:" and "Pinned
symbols:" sections — so they can be scored against a corpus task's
``requiredContext`` answer key. These tests pin:

- the canonical manifest format (shared verbatim with the run-side handoff test),
- that the "Checked, not relevant:" negatives are excluded,
- robustness to the messy free-text a cheap model actually emits (prose around
  the manifest, blank padding, bullet/dash variants, backticks, in-path hyphens,
  a dropped marker), and
- that the parsed set feeds the real ``pack_precision_recall`` scorer to the
  precision/recall the answer key implies.
"""

from __future__ import annotations

from agentrail.evals.gather_manifest import (
    ParsedManifest,
    parse_manifest,
    parse_manifest_paths,
)
from agentrail.evals.pack_scorer import pack_precision_recall


# The canonical manifest, byte-identical to the run-side handoff fixture
# (agentrail/tests/run/test_gather_manifest_handoff.py) so the two stay in sync.
MANIFEST = (
    "CONTEXT MANIFEST\n"
    "Relevant files:\n"
    "- agentrail/run/pipeline.py:301-340 — phase prompt assembly for the AC\n"
    "Pinned symbols:\n"
    "- agentrail/run/pipeline.py:301 — def run_issue_phase(rc, phase, "
    "execution_attempt, ...)\n"
    "Checked, not relevant:\n"
    "- checked console/ — not relevant because the change is pipeline-only"
)


# ---------------------------------------------------------------------------
# Canonical format
# ---------------------------------------------------------------------------


def test_canonical_manifest_selects_the_relevant_and_pinned_path():
    """Both scored sections point at one file; the checked negative is dropped."""
    assert parse_manifest_paths(MANIFEST) == {"agentrail/run/pipeline.py"}


def test_parse_manifest_splits_sections():
    """The rich result exposes each scored section separately."""
    parsed = parse_manifest(MANIFEST)

    assert isinstance(parsed, ParsedManifest)
    assert parsed.relevant_files == frozenset({"agentrail/run/pipeline.py"})
    assert parsed.pinned_symbols == frozenset({"agentrail/run/pipeline.py"})
    assert parsed.selected == frozenset({"agentrail/run/pipeline.py"})


def test_checked_not_relevant_is_excluded():
    """A path that appears ONLY under the negatives section is never selected."""
    manifest = (
        "CONTEXT MANIFEST\n"
        "Relevant files:\n"
        "- src/keep.py:1-10 — the change lives here\n"
        "Checked, not relevant:\n"
        "- checked src/drop.py — not relevant because it is unrelated\n"
        "- checked src/also_drop.py:5 — not relevant because dead code"
    )
    assert parse_manifest_paths(manifest) == {"src/keep.py"}


# ---------------------------------------------------------------------------
# Multiple distinct paths and de-duplication
# ---------------------------------------------------------------------------


def test_multiple_distinct_paths_across_both_sections():
    """Union spans every distinct file in the two scored sections."""
    manifest = (
        "CONTEXT MANIFEST\n"
        "Relevant files:\n"
        "- pkg/a.py:1-5 — a\n"
        "- pkg/b.py:10-20 — b\n"
        "Pinned symbols:\n"
        "- pkg/c.py:3 — def c()\n"
        "- pkg/b.py:11 — def b_helper()\n"
        "Checked, not relevant:\n"
        "- checked pkg/z.py — not relevant"
    )
    assert parse_manifest_paths(manifest) == {"pkg/a.py", "pkg/b.py", "pkg/c.py"}


def test_same_path_in_both_sections_collapses():
    """A file cited as both a relevant range and a pinned symbol counts once."""
    parsed = parse_manifest(MANIFEST)
    # present in both sections but the union is a single path
    assert parsed.relevant_files & parsed.pinned_symbols == frozenset(
        {"agentrail/run/pipeline.py"}
    )
    assert len(parsed.selected) == 1


# ---------------------------------------------------------------------------
# Robustness to a messy free-text reply
# ---------------------------------------------------------------------------


def test_prose_and_blank_padding_around_the_manifest():
    """Reconnaissance chatter before/after and blank lines don't pollute picks."""
    noisy = (
        "I searched the pipeline module and read the phase assembly.\n"
        "Here is what matters:\n"
        "\n"
        f"{MANIFEST}\n"
        "\n"
        "That's the manifest — the change is pipeline-only.\n"
    )
    assert parse_manifest_paths(noisy) == {"agentrail/run/pipeline.py"}


def test_in_path_hyphen_is_not_treated_as_the_trailer_separator():
    """A hyphen inside a filename must survive; only a spaced dash ends the head."""
    manifest = (
        "CONTEXT MANIFEST\n"
        "Relevant files:\n"
        "- agentrail/foo-bar_baz.py:1-9 — hyphenated module name\n"
    )
    assert parse_manifest_paths(manifest) == {"agentrail/foo-bar_baz.py"}


def test_tolerates_bullet_dash_and_backtick_variants():
    """Star/dot bullets, en-dash and double-hyphen trailers, backtick wraps."""
    manifest = (
        "CONTEXT MANIFEST\n"
        "Relevant files:\n"
        "* pkg/star.py:1-2 – en-dash trailer\n"
        "• `pkg/dot.py`:3 -- double-hyphen trailer\n"
        "- `pkg/tick.py` — backtick-wrapped path\n"
    )
    assert parse_manifest_paths(manifest) == {
        "pkg/star.py",
        "pkg/dot.py",
        "pkg/tick.py",
    }


def test_leading_dot_slash_is_stripped():
    """./relative paths normalise to the same key as the answer key uses."""
    manifest = (
        "CONTEXT MANIFEST\n"
        "Relevant files:\n"
        "- ./pkg/rel.py:1-2 — leading dot-slash\n"
    )
    assert parse_manifest_paths(manifest) == {"pkg/rel.py"}


def test_dropped_marker_falls_back_to_first_section_header():
    """If the model omits the CONTEXT MANIFEST line, sections still parse."""
    manifest = (
        "Relevant files:\n"
        "- pkg/a.py:1-2 — a\n"
        "Pinned symbols:\n"
        "- pkg/b.py:3 — def b()\n"
    )
    assert parse_manifest_paths(manifest) == {"pkg/a.py", "pkg/b.py"}


def test_last_marker_wins_over_an_earlier_mention():
    """Prose that names the manifest earlier doesn't hijack the real one."""
    text = (
        "I will end with a CONTEXT MANIFEST once I finish reading.\n"
        "Relevant files: (not yet — this is prose)\n"
        "\n"
        "CONTEXT MANIFEST\n"
        "Relevant files:\n"
        "- pkg/real.py:1-2 — the real pick\n"
    )
    assert parse_manifest_paths(text) == {"pkg/real.py"}


# ---------------------------------------------------------------------------
# Empty / degenerate inputs — undefined, never a fabricated pick
# ---------------------------------------------------------------------------


def test_empty_and_missing_inputs_return_empty_set():
    """No manifest -> no picks (the scorer reads this as precision None)."""
    assert parse_manifest_paths("") == set()
    assert parse_manifest_paths(None) == set()  # type: ignore[arg-type]
    assert parse_manifest_paths("no manifest anywhere in this reply") == set()


def test_marker_with_no_entries_returns_empty_set():
    """A header-only manifest (gatherer found nothing) selects nothing."""
    manifest = (
        "CONTEXT MANIFEST\n"
        "Relevant files:\n"
        "Pinned symbols:\n"
        "Checked, not relevant:\n"
    )
    assert parse_manifest_paths(manifest) == set()


# ---------------------------------------------------------------------------
# End-to-end with the real scorer — proves the whole measuring path
# ---------------------------------------------------------------------------


def test_parsed_paths_feed_the_real_precision_recall_scorer():
    """Parser output scored against an answer key yields the expected numbers."""
    manifest = (
        "CONTEXT MANIFEST\n"
        "Relevant files:\n"
        "- pkg/a.py:1-5 — required\n"
        "- pkg/b.py:1-5 — required\n"
        "- pkg/extra.py:1-5 — a wrong pick (not in the answer key)\n"
        "Pinned symbols:\n"
        "- pkg/a.py:2 — def a()\n"
    )
    required_context = ["pkg/a.py", "pkg/b.py", "pkg/c.py"]  # 3-file answer key

    cited = parse_manifest_paths(manifest)  # {a, b, extra}
    score = pack_precision_recall(cited, required_context)

    # 2 of the 3 cited paths are required -> precision 2/3
    assert score.precision == 2 / 3
    # 2 of the 3 required paths were cited -> recall 2/3
    assert score.recall == 2 / 3
    assert score.intersection == 2
    assert score.cited_count == 3
    assert score.required_count == 3


def test_no_manifest_scores_precision_none_not_zero():
    """An empty pick set is undefined precision, never a fabricated 0.0."""
    score = pack_precision_recall(parse_manifest_paths(""), ["pkg/a.py"])

    assert score.precision is None  # 0/0 undefined
    assert score.recall == 0.0  # a real answer key, zero hits

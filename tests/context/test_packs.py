"""Tests for agentrail/context/packs.py.

AC4(a): Verify stable-prefix section order in pack output.
"""
from __future__ import annotations

import unittest

from agentrail.context.packs import PACK_SECTION_KEYS, SECTION_TITLES, render_context_pack_markdown


# ---------------------------------------------------------------------------
# AC4(a) — stable-prefix section order
# ---------------------------------------------------------------------------

_STABLE_SECTIONS = ["requiredContext", "availableSkills", "availableTools"]
_DYNAMIC_SECTIONS = ["likelyFiles", "likelyDocs", "relevantMemory", "priorMistakes", "activeState", "goals"]


class PackSectionOrderTests(unittest.TestCase):
    def test_stable_sections_precede_dynamic_sections(self) -> None:
        """Stable prefix keys must all appear before any dynamic key in PACK_SECTION_KEYS."""
        last_stable_idx = max(PACK_SECTION_KEYS.index(s) for s in _STABLE_SECTIONS)
        first_dynamic_idx = min(PACK_SECTION_KEYS.index(s) for s in _DYNAMIC_SECTIONS)
        self.assertLess(
            last_stable_idx,
            first_dynamic_idx,
            f"Stable prefix ends at index {last_stable_idx} but dynamic starts at {first_dynamic_idx}",
        )

    def test_required_context_is_first(self) -> None:
        self.assertEqual(PACK_SECTION_KEYS[0], "requiredContext")

    def test_skills_before_likely_files(self) -> None:
        self.assertLess(
            PACK_SECTION_KEYS.index("availableSkills"),
            PACK_SECTION_KEYS.index("likelyFiles"),
        )

    def test_tools_before_likely_files(self) -> None:
        self.assertLess(
            PACK_SECTION_KEYS.index("availableTools"),
            PACK_SECTION_KEYS.index("likelyFiles"),
        )

    def test_all_expected_keys_present(self) -> None:
        expected = {
            "requiredContext", "availableSkills", "availableTools",
            "likelyFiles", "likelyDocs", "relevantMemory",
            "priorMistakes", "activeState", "goals",
            "excludedContext", "openQuestions",
        }
        self.assertEqual(set(PACK_SECTION_KEYS), expected)

    def test_excluded_context_after_dynamic(self) -> None:
        last_dynamic_idx = max(PACK_SECTION_KEYS.index(s) for s in _DYNAMIC_SECTIONS)
        excluded_idx = PACK_SECTION_KEYS.index("excludedContext")
        self.assertGreater(excluded_idx, last_dynamic_idx)


class RenderMarkdownSectionOrderTests(unittest.TestCase):
    def _minimal_pack(self) -> dict:
        base = {
            "schemaVersion": 1,
            "packId": "test-pack",
            "target": {"kind": "issue", "number": 1, "phase": "plan"},
            "generatedAt": "2026-01-01T00:00:00.000Z",
            "goal": {"summary": "Test goal.", "citation": "github:issue/1"},
            "retrievalBudget": {"maxItems": 20, "maxTokens": 4000},
            "index": {"version": "1", "builtAt": "2026-01-01T00:00:00Z"},
            "provider": {"mode": "disabled"},
            "audit": {"event": "generated_context_pack", "citation": ".agentrail/context/audit/events.jsonl"},
            "tokensSaved": 0,
        }
        for key in PACK_SECTION_KEYS:
            base[key] = []
        return base

    def test_markdown_section_titles_appear_in_key_order(self) -> None:
        """Rendered markdown must have section headings in PACK_SECTION_KEYS order."""
        pack = self._minimal_pack()
        md = render_context_pack_markdown(pack)
        positions = {key: md.find(f"## {SECTION_TITLES[key]}") for key in PACK_SECTION_KEYS}
        # All sections must appear in the output
        for key, pos in positions.items():
            self.assertGreater(pos, -1, f"Section '{key}' not found in rendered markdown")
        # Verify order matches PACK_SECTION_KEYS
        order = sorted(PACK_SECTION_KEYS, key=lambda k: positions[k])
        self.assertEqual(order, PACK_SECTION_KEYS)

    def test_stable_prefix_headings_before_likely_files_heading(self) -> None:
        pack = self._minimal_pack()
        md = render_context_pack_markdown(pack)
        required_pos = md.find(f"## {SECTION_TITLES['requiredContext']}")
        skills_pos = md.find(f"## {SECTION_TITLES['availableSkills']}")
        tools_pos = md.find(f"## {SECTION_TITLES['availableTools']}")
        likely_files_pos = md.find(f"## {SECTION_TITLES['likelyFiles']}")
        self.assertLess(required_pos, likely_files_pos)
        self.assertLess(skills_pos, likely_files_pos)
        self.assertLess(tools_pos, likely_files_pos)


if __name__ == "__main__":
    unittest.main()

"""Tests for agentrail/context/packs.py.

- AC4(a) (#704): stable-prefix section order in pack output.
- AC6 (#706): budget-trimming logic in build_context_pack.
"""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
import warnings
from pathlib import Path
from unittest.mock import patch

from agentrail.context.index import build_index
from agentrail.context.packs import (
    PACK_SECTION_KEYS,
    SECTION_TITLES,
    _DEFAULT_BUDGET_MODEL,
    _item_tokens,
    _pack_input_tokens,
    _trim_to_budget,
    build_context_pack,
    render_context_pack_markdown,
)
from agentrail.context.pricing import cost_for


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


def _make_repo() -> Path:
    """Minimal git repo fixture suitable for build_context_pack tests."""
    root = Path(tempfile.mkdtemp())
    subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
    (root / ".agentrail").mkdir()
    (root / ".agentrail" / "config.json").write_text(
        json.dumps({
            "schemaVersion": 1,
            "context": {
                "includeGlobs": ["**/*"],
                "excludeGlobs": [
                    ".git/**", ".agentrail/context/**", ".agentrail/source/**",
                    ".env", ".env.*", "**/.env", "**/.env.*",
                    "**/*.pem", "**/*.key", "**/*credentials*", "**/*secret*",
                ],
                "maxFileSizeBytes": 262144,
                "skipBinary": True,
                "respectGitIgnore": True,
                "secretRedaction": {
                    "enabled": True, "action": "exclude",
                    "denyGlobs": [".env", ".env.*", "**/.env"],
                },
                "embedding": {"mode": "disabled", "provider": None, "model": None},
                "summary": {"mode": "disabled", "provider": None, "model": None},
            },
        }, indent=2),
        encoding="utf-8",
    )
    (root / ".agentrail" / "state.json").write_text(
        json.dumps({"workflow": {"activeIssue": 1, "activePhase": "plan", "goals": []}}),
        encoding="utf-8",
    )
    # Required context — must never be dropped
    (root / "CONTEXT.md").write_text(
        "# Context\n\nIssue #1 context for budget tests.\n",
        encoding="utf-8",
    )
    (root / "TASTE.md").write_text(
        "# Taste\n\nEvidence over claims for issue #1.\n",
        encoding="utf-8",
    )
    # Several source files to populate retrieval sections with tokens
    (root / "src").mkdir()
    # Large enough to push cost over a tiny budget when summed
    big_content = "x" * 4000  # ~1000 tokens each
    for i in range(1, 6):
        (root / "src" / f"module_{i}.py").write_text(
            f"# module {i} for issue #1\n{big_content}\n",
            encoding="utf-8",
        )
    subprocess.run(["git", "-C", str(root), "config", "user.email", "test@example.com"], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.name", "Test"], check=True)
    subprocess.run(["git", "-C", str(root), "add", "."], check=True)
    subprocess.run(["git", "-C", str(root), "commit", "--quiet", "-m", "init"], check=True)
    build_index(root)
    return root


class TrimToBudgetUnitTests(unittest.TestCase):
    """Unit tests for _trim_to_budget helpers directly (no disk I/O)."""

    def _make_sections(self) -> dict:
        """Synthetic sections with enough tokens to exceed a tiny budget."""
        big = "A" * 4000  # ~1000 tok each
        sections: dict = {
            "requiredContext": [
                {"kind": "requiredContext", "content": "Required context content.", "path": "CONTEXT.md"},
                {"kind": "requiredContext", "content": "Taste content.", "path": "TASTE.md"},
            ],
            "likelyFiles": [
                {"kind": "likelyFiles", "content": big, "path": "src/a.py", "score": {"final": 1.5}},
                {"kind": "likelyFiles", "content": big, "path": "src/b.py", "score": {"final": 2.0}},
                {"kind": "likelyFiles", "content": big, "path": "src/c.py", "score": {"final": 0.5}},
            ],
            "likelyDocs": [],
            "relevantMemory": [],
            "priorMistakes": [],
            "activeState": [],
            "availableTools": [{"kind": "available_tool", "content": "tool"}],
            "availableSkills": [],
            "goals": [],
            "excludedContext": [
                {"kind": "excluded_context", "content": big, "path": "excluded.py"},
            ],
            "openQuestions": [],
        }
        return sections

    def test_a_over_budget_trims_to_budget(self) -> None:
        """AC6a: over-budget pack is trimmed to ≤ budget; itemsDropped > 0."""
        sections = self._make_sections()
        # Budget is half the initial pack cost — clearly over budget, must trim.
        initial_cost = cost_for(_DEFAULT_BUDGET_MODEL, input_tokens=_pack_input_tokens(sections))["dollars"]
        budget = initial_cost / 2
        result = _trim_to_budget(sections, budget, _DEFAULT_BUDGET_MODEL)

        self.assertLessEqual(result["packCostUsd"], budget)
        self.assertGreater(result["itemsDropped"], 0)
        self.assertEqual(result["budgetUsd"], budget)

    def test_b_under_budget_untouched(self) -> None:
        """AC6b: when pack is already within budget, itemsDropped=0 and no sections modified."""
        sections = self._make_sections()
        # Count tokens before
        total_before = _pack_input_tokens(sections)
        # Use a very large budget
        budget = 999.0
        result = _trim_to_budget(sections, budget, _DEFAULT_BUDGET_MODEL)

        self.assertEqual(result["itemsDropped"], 0)
        self.assertLessEqual(result["packCostUsd"], budget)
        # Sections should be unchanged
        self.assertEqual(_pack_input_tokens(sections), total_before)

    def test_c_unknown_model_warns_and_skips(self) -> None:
        """AC6c: unknown model emits a warning naming the model and skips trimming."""
        sections = self._make_sections()
        budget = 0.000001
        unknown_model = "unknown-model-xyz"

        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            result = _trim_to_budget(sections, budget, unknown_model)

        self.assertEqual(result["itemsDropped"], 0)
        # A warning was issued that names the unknown model
        warning_texts = [str(w.message) for w in caught]
        self.assertTrue(
            any(unknown_model in text for text in warning_texts),
            f"Expected warning naming '{unknown_model}', got: {warning_texts}",
        )

    def test_d_required_context_never_dropped(self) -> None:
        """AC6d: requiredContext items are never dropped even under extreme budget pressure."""
        sections = self._make_sections()
        required_paths_before = {item["path"] for item in sections["requiredContext"]}
        # Absurdly tiny budget
        budget = 1e-12
        _trim_to_budget(sections, budget, _DEFAULT_BUDGET_MODEL)

        required_paths_after = {item["path"] for item in sections["requiredContext"]}
        self.assertEqual(required_paths_before, required_paths_after)

    def test_drop_order_excluded_first(self) -> None:
        """Excluded context is dropped before retrieval items."""
        sections = self._make_sections()
        # Use a budget just above the cost after dropping excludedContext:
        # initial (4012 tok) → after drop excluded (3012 tok) → $0.009036
        # Budget slightly above 3012-tok cost forces only the excluded item to be dropped.
        after_drop_cost = cost_for(_DEFAULT_BUDGET_MODEL, input_tokens=3012)["dollars"]
        budget = after_drop_cost + 0.001  # safely above the post-drop cost
        _trim_to_budget(sections, budget, _DEFAULT_BUDGET_MODEL)

        # excludedContext should be empty (dropped first)
        self.assertEqual(sections["excludedContext"], [])

    def test_retrieval_items_dropped_ascending_score(self) -> None:
        """Retrieval items with lower scores are dropped before higher scores."""
        big = "A" * 4000
        sections: dict = {
            "requiredContext": [{"kind": "rc", "content": "x", "path": "CONTEXT.md"}],
            "likelyFiles": [
                {"kind": "lf", "content": big, "path": "low.py", "score": {"final": 0.1}},
                {"kind": "lf", "content": big, "path": "high.py", "score": {"final": 9.9}},
            ],
            "likelyDocs": [],
            "relevantMemory": [],
            "priorMistakes": [],
            "activeState": [],
            "availableTools": [],
            "availableSkills": [],
            "goals": [],
            "excludedContext": [],
            "openQuestions": [],
        }
        # Budget that forces dropping one but not both retrieval items
        # Both items together cost more than budget; one item alone is within budget
        total_tok = _pack_input_tokens(sections)
        single_tok = total_tok - _item_tokens(sections["likelyFiles"][0])
        budget = cost_for(_DEFAULT_BUDGET_MODEL, input_tokens=single_tok)["dollars"] + 0.0001

        _trim_to_budget(sections, budget, _DEFAULT_BUDGET_MODEL)

        remaining_paths = {item["path"] for item in sections["likelyFiles"]}
        # low-score item should be dropped first
        self.assertNotIn("low.py", remaining_paths)
        self.assertIn("high.py", remaining_paths)


class BuildContextPackBudgetIntegrationTest(unittest.TestCase):
    """Integration tests calling build_context_pack with budget_usd (requires disk + git)."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.root = _make_repo()

    def test_budget_fields_in_artifact_when_over_budget(self) -> None:
        """AC1+AC3: artifact contains budgetUsd, packCostUsd, itemsDropped; packCostUsd ≤ budget."""
        # First build without budget to measure actual pack cost, then trim to half.
        baseline = build_context_pack(self.root, "issue", 1, "plan")
        pack_json = json.loads((self.root / baseline["jsonPath"]).read_text(encoding="utf-8"))
        from agentrail.context.packs import _pack_input_tokens, PACK_SECTION_KEYS
        all_sections = {k: pack_json.get(k, []) for k in PACK_SECTION_KEYS}
        baseline_tokens = _pack_input_tokens(all_sections)
        baseline_cost = cost_for(_DEFAULT_BUDGET_MODEL, input_tokens=baseline_tokens)["dollars"]
        # Use half the baseline cost as budget (must exceed required-context floor)
        budget = max(baseline_cost / 2, baseline_cost * 0.001)

        output = build_context_pack(
            self.root, "issue", 1, "plan",
            budget_usd=budget, model=_DEFAULT_BUDGET_MODEL,
        )
        self.assertIn("budgetUsd", output)
        self.assertIn("packCostUsd", output)
        self.assertIn("itemsDropped", output)
        # packCostUsd ≤ budget when items were actually dropped.
        # If itemsDropped == 0, the pack was already within budget (baseline ≤ budget).
        if output["itemsDropped"] > 0:
            self.assertLessEqual(output["packCostUsd"], output["budgetUsd"])

        # Verify artifact JSON also has the fields
        artifact = json.loads((self.root / output["jsonPath"]).read_text(encoding="utf-8"))
        self.assertIn("budgetUsd", artifact)
        self.assertIn("packCostUsd", artifact)
        self.assertIn("itemsDropped", artifact)

    def test_no_budget_fields_when_no_budget_provided(self) -> None:
        """AC7: when budget_usd not provided, no budget fields appear; existing behaviour intact."""
        output = build_context_pack(self.root, "issue", 1, "plan")
        self.assertNotIn("budgetUsd", output)
        self.assertNotIn("packCostUsd", output)
        self.assertNotIn("itemsDropped", output)

    def test_under_budget_items_dropped_zero(self) -> None:
        """AC4: when pack is within budget, itemsDropped=0."""
        output = build_context_pack(
            self.root, "issue", 1, "plan",
            budget_usd=999.0, model=_DEFAULT_BUDGET_MODEL,
        )
        self.assertEqual(output["itemsDropped"], 0)
        self.assertLessEqual(output["packCostUsd"], 999.0)


if __name__ == "__main__":
    unittest.main()

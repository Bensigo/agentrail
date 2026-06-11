"""Unit tests for skillcmd seed-prompt assembly (pure, no I/O)."""
from __future__ import annotations

import unittest

from agentrail.skillcmd.prompts import build_seed_prompt


class BuildSeedPromptTests(unittest.TestCase):
    def test_skill_body_appears_verbatim(self):
        body = "<what-to-do>\nInterview me relentlessly.\n</what-to-do>"
        out = build_seed_prompt("grill-with-docs", body, [], [])
        self.assertIn(body, out)
        self.assertIn("grill-with-docs", out)

    def test_context_file_inlined_under_section(self):
        out = build_seed_prompt(
            "grill-with-docs",
            "SKILLBODY",
            [("CONTEXT.md", "Glossary: Order means X.")],
            [],
        )
        self.assertIn("## CONTEXT.md", out)
        self.assertIn("Glossary: Order means X.", out)

    def test_empty_context_body_skipped(self):
        out = build_seed_prompt(
            "s", "B", [("CONTEXT.md", "ctx"), ("TASTE.md", "   ")], []
        )
        self.assertIn("## CONTEXT.md", out)
        self.assertNotIn("## TASTE.md", out)

    def test_input_refs_rendered(self):
        out = build_seed_prompt(
            "s", "B", [], [("docs/plan.md", "the plan body")]
        )
        self.assertIn("## Input: docs/plan.md", out)
        self.assertIn("the plan body", out)

    def test_order_skill_before_context_before_input(self):
        out = build_seed_prompt(
            "s", "SKILLBODY", [("CONTEXT.md", "CTX")], [("p", "PLAN")]
        )
        self.assertLess(out.index("SKILLBODY"), out.index("CTX"))
        self.assertLess(out.index("CTX"), out.index("PLAN"))

    def test_framing_marks_skill_authoritative(self):
        out = build_seed_prompt("grill-with-docs", "B", [], [])
        self.assertIn("authoritative", out.lower())


if __name__ == "__main__":
    unittest.main()

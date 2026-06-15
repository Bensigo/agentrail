from __future__ import annotations

import unittest

from agentrail.context.pricing import cost_for


class PricingLookupTests(unittest.TestCase):
    # -----------------------------------------------------------------
    # Anthropic
    # -----------------------------------------------------------------

    def test_anthropic_claude_sonnet_input_lookup(self) -> None:
        result = cost_for("claude-sonnet-4-5", input_tokens=1_000_000)
        self.assertFalse(result["estimate"])
        self.assertGreater(result["dollars"], 0)
        self.assertEqual(result["model"], "claude-sonnet-4-5")

    def test_anthropic_output_rate_exceeds_input(self) -> None:
        result_in = cost_for("claude-sonnet-4-5", input_tokens=1_000_000)
        result_out = cost_for("claude-sonnet-4-5", output_tokens=1_000_000)
        self.assertGreater(result_out["dollars"], result_in["dollars"])

    def test_anthropic_cached_read_distinct_from_input(self) -> None:
        result_in = cost_for("claude-sonnet-4-5", input_tokens=1_000_000)
        result_cr = cost_for("claude-sonnet-4-5", cached_read=1_000_000)
        # cached-read should be cheaper than regular input
        self.assertLess(result_cr["dollars"], result_in["dollars"])

    def test_anthropic_cached_write_positive(self) -> None:
        result = cost_for("claude-sonnet-4-5", cached_write=1_000_000)
        self.assertGreater(result["dollars"], 0)

    def test_anthropic_haiku_lookup(self) -> None:
        result = cost_for("claude-haiku-4-5", input_tokens=500_000)
        self.assertFalse(result["estimate"])
        self.assertGreater(result["dollars"], 0)

    def test_anthropic_opus_lookup(self) -> None:
        result = cost_for("claude-opus-4-6", input_tokens=100_000)
        self.assertFalse(result["estimate"])
        self.assertGreater(result["dollars"], 0)

    # -----------------------------------------------------------------
    # OpenAI / Codex
    # -----------------------------------------------------------------

    def test_openai_gpt4o_lookup(self) -> None:
        result = cost_for("gpt-4o", input_tokens=1_000_000)
        self.assertFalse(result["estimate"])
        self.assertGreater(result["dollars"], 0)

    def test_openai_output_rate_exceeds_input(self) -> None:
        result_in = cost_for("gpt-4o", input_tokens=1_000_000)
        result_out = cost_for("gpt-4o", output_tokens=1_000_000)
        self.assertGreater(result_out["dollars"], result_in["dollars"])

    def test_openai_gpt41_lookup(self) -> None:
        result = cost_for("gpt-4.1", input_tokens=500_000)
        self.assertFalse(result["estimate"])
        self.assertGreater(result["dollars"], 0)

    # -----------------------------------------------------------------
    # Cursor
    # -----------------------------------------------------------------

    def test_cursor_model_lookup(self) -> None:
        result = cost_for("cursor/claude-sonnet-4-5", input_tokens=1_000_000)
        self.assertFalse(result["estimate"])
        self.assertGreater(result["dollars"], 0)

    # -----------------------------------------------------------------
    # Fallback (unknown model)
    # -----------------------------------------------------------------

    def test_unknown_model_estimate_flag(self) -> None:
        result = cost_for("nonexistent-model-xyz", input_tokens=4_000)
        self.assertTrue(result["estimate"])
        self.assertEqual(result["estimator"], "chars/4")

    def test_unknown_model_still_returns_positive_dollars(self) -> None:
        result = cost_for("nonexistent-model-xyz", input_tokens=4_000)
        self.assertGreater(result["dollars"], 0)

    def test_unknown_model_includes_model_field(self) -> None:
        result = cost_for("nonexistent-model-xyz", input_tokens=1000)
        self.assertEqual(result["model"], "nonexistent-model-xyz")

    # -----------------------------------------------------------------
    # Multi-category costing
    # -----------------------------------------------------------------

    def test_combined_tokens_sum_correctly(self) -> None:
        r_in = cost_for("claude-sonnet-4-5", input_tokens=1_000_000)
        r_out = cost_for("claude-sonnet-4-5", output_tokens=1_000_000)
        r_cr = cost_for("claude-sonnet-4-5", cached_read=1_000_000)
        r_cw = cost_for("claude-sonnet-4-5", cached_write=1_000_000)
        r_all = cost_for(
            "claude-sonnet-4-5",
            input_tokens=1_000_000,
            output_tokens=1_000_000,
            cached_read=1_000_000,
            cached_write=1_000_000,
        )
        expected = r_in["dollars"] + r_out["dollars"] + r_cr["dollars"] + r_cw["dollars"]
        self.assertAlmostEqual(r_all["dollars"], expected, places=8)

    def test_zero_tokens_returns_zero_dollars(self) -> None:
        result = cost_for("claude-sonnet-4-5")
        self.assertEqual(result["dollars"], 0.0)


if __name__ == "__main__":
    unittest.main()

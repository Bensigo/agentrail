from __future__ import annotations

import unittest
from pathlib import Path

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


class SingleSourceOfTruthTests(unittest.TestCase):
    """#715: there must be exactly one price table — run/pricing derives from it."""

    def test_run_prices_derived_from_canonical_table(self) -> None:
        from agentrail.context.pricing import PRICE_TABLE
        from agentrail.run.pricing import PRICES

        # Same model coverage.
        self.assertEqual(set(PRICES), set(PRICE_TABLE))
        # Every run/pricing rate must equal the canonical table (cache=cached_read).
        for model, rates in PRICES.items():
            canon = PRICE_TABLE[model]
            self.assertEqual(rates.input, canon["input"], model)
            self.assertEqual(rates.output, canon["output"], model)
            self.assertEqual(rates.cache, canon["cached_read"], model)

    def test_run_pricing_has_no_second_hardcoded_table(self) -> None:
        """run/pricing.py must not hardcode numeric rates (it derives from the canonical table)."""
        import re
        import agentrail.run.pricing as rp
        src = Path(rp.__file__).read_text(encoding="utf-8")
        # A hardcoded table would have `_Rates(input=10.00, ...)` literals with digits.
        # The derivation comprehension uses `_Rates(input=r["input"], ...)` (no digit).
        hardcoded = re.findall(r"_Rates\(input=\s*\d", src)
        self.assertEqual(hardcoded, [],
                         "run/pricing.py reintroduced a hardcoded numeric rate table — "
                         "derive from context.pricing.PRICE_TABLE instead")

    def test_no_rate_conflicts_for_shared_models(self) -> None:
        """The opus-4-6 / haiku-4-5 conflicts that motivated #715 stay resolved."""
        from agentrail.context.pricing import PRICE_TABLE
        self.assertEqual(PRICE_TABLE["claude-opus-4-6"]["input"], 5.0)
        self.assertEqual(PRICE_TABLE["claude-opus-4-6"]["output"], 25.0)
        self.assertEqual(PRICE_TABLE["claude-haiku-4-5"]["input"], 1.0)
        self.assertEqual(PRICE_TABLE["claude-haiku-4-5"]["output"], 5.0)


if __name__ == "__main__":
    unittest.main()

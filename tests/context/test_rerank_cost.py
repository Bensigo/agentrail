"""Acceptance tests for issue #1044 AC3 — rerank-layer cost telemetry.

AC3: "Rerank-layer cost appears as its own line in the per-component cost
breakdown."  When the LLM listwise rerank ran (flag ON — its usage block is
always present then, including on fallback), ``build_context_pack`` prices the
metered ``compiler.rerank.llm`` block through the canonical price table
(agentrail/context/pricing.py) and surfaces it as ``rerankCostUsd`` on the
pack artifact + summary result, plus a ``- Rerank cost: $... USD`` Metadata
line in the rendered markdown.  Flag OFF must stay byte-identical: no key, no
line.

No test here touches the network: ``_call_model`` is the single seam and every
flag-ON test monkeypatches the module global (or keeps the key unset so the
fail-open path short-circuits before the seam).
"""
from __future__ import annotations

import copy
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import ExitStack, contextmanager
from pathlib import Path
from unittest import mock

from agentrail.context.index import build_index
from agentrail.context.llm_rerank import LLM_RERANK_DEFAULT_MODEL, llm_rerank_cost_usd
from agentrail.context.packs import (
    PACK_SECTION_KEYS,
    build_context_pack,
    render_context_pack_markdown,
)
from agentrail.context.pricing import PRICE_TABLE, cost_for

_FLAG = "AGENTRAIL_CONTEXT_LLM_RERANK"
_MTOK = 1_000_000.0


@contextmanager
def _env(key: str, value: str | None):
    """Temporarily set (or unset, for value=None) an env var."""
    prev = os.environ.get(key)
    if value is None:
        os.environ.pop(key, None)
    else:
        os.environ[key] = value
    try:
        yield
    finally:
        if prev is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = prev


@contextmanager
def _envs(**pairs: str | None):
    """Apply several _env overrides at once (keys are passed verbatim)."""
    with ExitStack() as stack:
        for key, value in pairs.items():
            stack.enter_context(_env(key, value))
        yield


def _usage(input_tokens: int = 100, output_tokens: int = 10) -> dict:
    return {
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "cacheCreationInputTokens": 0,
        "cacheReadInputTokens": 0,
    }


def _prompt_ids(prompt: str) -> list[str]:
    """Candidate ids in prompt order, parsed from the '[cN] path=...' lines."""
    ids = []
    for line in prompt.splitlines():
        stripped = line.strip()
        if stripped.startswith("[c") and "]" in stripped:
            ids.append(stripped[1 : stripped.index("]")])
    return ids


def _reversing_call(model: str, prompt: str) -> tuple[str, dict]:
    """Fake model: reverse every window (a maximally order-changing response)."""
    return json.dumps(list(reversed(_prompt_ids(prompt)))), _usage()


# ---------------------------------------------------------------------------
# llm_rerank_cost_usd — pure pricing helper
# ---------------------------------------------------------------------------


class LlmRerankCostUsdTests(unittest.TestCase):
    def test_prices_all_four_usage_components_for_the_pinned_model(self) -> None:
        """Every counter (input/output/cache-read/cache-write) must be priced,
        with the expectation DERIVED from PRICE_TABLE — not a magic dollar
        constant that would silently drift when rates change."""
        llm = {
            "model": LLM_RERANK_DEFAULT_MODEL,
            "calls": 4,
            "inputTokens": 123_456,
            "outputTokens": 7_890,
            "cacheCreationInputTokens": 55_000,
            "cacheReadInputTokens": 200_000,
        }
        rates = PRICE_TABLE[LLM_RERANK_DEFAULT_MODEL]
        expected = (
            llm["inputTokens"] * rates["input"]
            + llm["outputTokens"] * rates["output"]
            + llm["cacheReadInputTokens"] * rates["cached_read"]
            + llm["cacheCreationInputTokens"] * rates["cached_write"]
        ) / _MTOK
        self.assertGreater(expected, 0.0, "fixture must exercise a nonzero cost")
        self.assertAlmostEqual(llm_rerank_cost_usd(llm), expected, places=12)

    def test_matches_the_canonical_cost_for_exactly(self) -> None:
        llm = {
            "model": LLM_RERANK_DEFAULT_MODEL,
            "inputTokens": 400,
            "outputTokens": 40,
            "cacheCreationInputTokens": 0,
            "cacheReadInputTokens": 0,
        }
        self.assertEqual(
            llm_rerank_cost_usd(llm),
            cost_for(
                LLM_RERANK_DEFAULT_MODEL,
                input_tokens=400,
                output_tokens=40,
                cached_read=0,
                cached_write=0,
            )["dollars"],
            "the helper must route through the single canonical price table",
        )

    def test_missing_and_none_counters_default_to_zero(self) -> None:
        """A fallback block can carry partial (or zero) usage — the helper
        must price it cleanly instead of raising."""
        self.assertEqual(llm_rerank_cost_usd({}), 0.0)
        self.assertEqual(llm_rerank_cost_usd({"model": LLM_RERANK_DEFAULT_MODEL}), 0.0)
        self.assertEqual(
            llm_rerank_cost_usd({"model": LLM_RERANK_DEFAULT_MODEL, "inputTokens": None}),
            0.0,
        )
        partial = {"model": LLM_RERANK_DEFAULT_MODEL, "inputTokens": 50}
        rates = PRICE_TABLE[LLM_RERANK_DEFAULT_MODEL]
        self.assertAlmostEqual(
            llm_rerank_cost_usd(partial), 50 * rates["input"] / _MTOK, places=12
        )


# ---------------------------------------------------------------------------
# render_context_pack_markdown — the AC3 cost line, tested directly
# ---------------------------------------------------------------------------


class RenderMarkdownRerankCostLineTests(unittest.TestCase):
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

    def test_no_rerank_cost_key_renders_no_line(self) -> None:
        md = render_context_pack_markdown(self._minimal_pack())
        self.assertNotIn("Rerank cost", md, "flag OFF markdown must stay byte-identical")

    def test_rerank_cost_line_renders_with_model_and_calls(self) -> None:
        pack = self._minimal_pack()
        pack["compiler"] = {
            "rerank": {
                "llm": {"model": LLM_RERANK_DEFAULT_MODEL, "calls": 3, **_usage(300, 30)},
            },
        }
        pack["rerankCostUsd"] = llm_rerank_cost_usd(pack["compiler"]["rerank"]["llm"])
        md = render_context_pack_markdown(pack)
        expected_line = (
            f"- Rerank cost: ${pack['rerankCostUsd']:.6f} USD"
            f" (model={LLM_RERANK_DEFAULT_MODEL}, calls=3)"
        )
        self.assertIn(expected_line, md)

    def test_line_renders_independently_of_budget_lines(self) -> None:
        """AC3 line must not be gated on --budget-usd: the rerank LLM spends
        real dollars whether or not a budget was passed."""
        pack = self._minimal_pack()
        self.assertNotIn("budgetUsd", pack)  # no budget metadata at all
        pack["compiler"] = {
            "rerank": {"llm": {"model": LLM_RERANK_DEFAULT_MODEL, "calls": 1, **_usage()}},
        }
        pack["rerankCostUsd"] = llm_rerank_cost_usd(pack["compiler"]["rerank"]["llm"])
        md = render_context_pack_markdown(pack)
        self.assertIn("- Rerank cost: $", md)
        self.assertNotIn("- Budget:", md)

    def test_fallback_with_partial_usage_still_renders_the_line(self) -> None:
        """An api_error fallback carries PARTIAL usage — aborted attempts spent
        real dollars, so the cost line must still appear."""
        pack = self._minimal_pack()
        partial = {
            "model": LLM_RERANK_DEFAULT_MODEL,
            "calls": 1,
            "inputTokens": 50,
            "outputTokens": 5,
            "cacheCreationInputTokens": 0,
            "cacheReadInputTokens": 0,
        }
        pack["compiler"] = {
            "rerank": {"llm": partial, "llmFallback": "api_error:RuntimeError"},
        }
        pack["rerankCostUsd"] = llm_rerank_cost_usd(partial)
        self.assertGreater(pack["rerankCostUsd"], 0.0)
        md = render_context_pack_markdown(pack)
        self.assertIn(
            f"- Rerank cost: ${pack['rerankCostUsd']:.6f} USD"
            f" (model={LLM_RERANK_DEFAULT_MODEL}, calls=1)",
            md,
        )

    def test_zero_cost_fallback_renders_a_zero_dollar_line(self) -> None:
        """missing_model_path fallback = zero usage, but the layer still ran —
        an explicit $0.000000 is honest telemetry, not noise."""
        pack = self._minimal_pack()
        zero = {"model": LLM_RERANK_DEFAULT_MODEL, "calls": 0, **_usage(0, 0)}
        pack["compiler"] = {"rerank": {"llm": zero, "llmFallback": "missing_model_path"}}
        pack["rerankCostUsd"] = 0.0
        md = render_context_pack_markdown(pack)
        self.assertIn("- Rerank cost: $0.000000 USD", md)


# ---------------------------------------------------------------------------
# build_context_pack — real pipeline integration
# ---------------------------------------------------------------------------

# The fixture's answer symbol repeats the pack query's words so it is retrieved
# lexically as a code candidate (same trick as tests/context/test_llm_rerank.py).
_PLANNER_SOURCE = '''def plan_pack(target):
    """Plan the context pack for a target issue.

    Covers required context, likely files, docs, memory, prior mistakes,
    active state, tools, skills, excluded context and open questions.
    """
    sections = [
        "required context",
        "likely files",
        "docs",
        "memory",
        "prior mistakes",
        "active state",
        "tools",
        "skills",
        "excluded context",
        "open questions",
    ]
    return {"target": target, "sections": sections}
'''


def _make_repo() -> Path:
    """Git repo fixture merging test_llm_rerank.py's retrievable content with
    test_packs.py's workflow state, so build_context_pack(root, "issue", 1,
    "plan") runs the full retrieval + rerank pipeline."""
    root = Path(tempfile.mkdtemp())
    (root / ".agentrail").mkdir()
    (root / ".agentrail" / "config.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "context": {
                    "includeGlobs": ["**/*"],
                    "excludeGlobs": [".git/**", ".agentrail/context/**"],
                    "maxFileSizeBytes": 262144,
                    "skipBinary": True,
                    "respectGitIgnore": True,
                    "secretRedaction": {"enabled": False, "action": "exclude", "denyGlobs": []},
                    "embedding": {"mode": "disabled"},
                    "summary": {"mode": "disabled"},
                },
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    (root / ".agentrail" / "state.json").write_text(
        json.dumps({"workflow": {"activeIssue": 1, "activePhase": "plan", "goals": []}}),
        encoding="utf-8",
    )
    (root / "CONTEXT.md").write_text(
        "# Context\n\nContext pack planning covers required context, likely "
        "files, docs, memory, prior mistakes and open questions for issue #1.\n",
        encoding="utf-8",
    )
    (root / "TASTE.md").write_text(
        "# Taste\n\nEvidence over claims for issue #1.\n",
        encoding="utf-8",
    )
    docs = root / "docs"
    docs.mkdir()
    (docs / "planning-notes.md").write_text(
        "# Planning notes\n\nRequired context, likely files, docs, memory, "
        "active state, tools, skills, excluded context, open questions.\n",
        encoding="utf-8",
    )
    src = root / "agentrail"
    src.mkdir()
    (src / "planner.py").write_text(_PLANNER_SOURCE, encoding="utf-8")
    subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.email", "t@t.com"], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.name", "t"], check=True)
    subprocess.run(["git", "-C", str(root), "add", "."], check=True)
    subprocess.run(["git", "-C", str(root), "commit", "--quiet", "-m", "init"], check=True)
    build_index(root)
    return root


_VOLATILE_KEYS = {"packId", "generatedAt", "queryGeneratedAt", "builtAt"}


def _canonical(payload: dict) -> str:
    """Pack payload with volatile fields (timestamps/ids) scrubbed so two runs
    compare byte-identical."""

    def scrub(value):
        if isinstance(value, dict):
            # *Path keys embed the packId timestamp (jsonPath, markdownPath,
            # generatedPackMarkdownPath, ...), so they differ run to run.
            return {
                k: scrub(v)
                for k, v in value.items()
                if k not in _VOLATILE_KEYS and not k.endswith("Path")
            }
        if isinstance(value, list):
            return [scrub(v) for v in value]
        return value

    return json.dumps(scrub(copy.deepcopy(payload)), sort_keys=True)


class BuildContextPackRerankCostIntegrationTests(unittest.TestCase):
    """Flag ON ⇒ rerankCostUsd threads through the pack artifact, the summary
    result, and the rendered markdown; flag OFF ⇒ byte-identical to today."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.root = _make_repo()

    def _build(self, *, model_path: bool | None = None, **env: str | None) -> dict:
        with ExitStack() as stack:
            stack.enter_context(_envs(AGENTRAIL_CONTEXT_RERANK="1", **env))
            if model_path is not None:
                # The rerank gates on the headless ``claude -p`` path being
                # resolvable (issue #1044), not on ANTHROPIC_API_KEY; drive that
                # gate directly instead of depending on a real ``claude`` binary.
                stack.enter_context(
                    mock.patch(
                        "agentrail.context.llm_rerank.llm_rerank_model_path_available",
                        return_value=model_path,
                    )
                )
            return build_context_pack(self.root, "issue", 1, "plan")

    def _artifact(self, output: dict) -> dict:
        return json.loads((self.root / output["jsonPath"]).read_text(encoding="utf-8"))

    def _markdown(self, output: dict) -> str:
        return (self.root / output["markdownPath"]).read_text(encoding="utf-8")

    def test_flag_off_pack_carries_no_cost_key_and_no_line(self) -> None:
        """Byte-identity guard: flag unset and flag '0' produce the same
        artifact (volatile fields scrubbed), and neither carries the key/line."""
        unset_output = self._build(**{_FLAG: None})
        unset_artifact = self._artifact(unset_output)
        unset_md = self._markdown(unset_output)
        off_output = self._build(**{_FLAG: "0"})
        off_artifact = self._artifact(off_output)
        off_md = self._markdown(off_output)

        self.assertEqual(
            _canonical(unset_artifact),
            _canonical(off_artifact),
            "flag '0' must be byte-identical to flag-unset",
        )
        for output, artifact, md in (
            (unset_output, unset_artifact, unset_md),
            (off_output, off_artifact, off_md),
        ):
            self.assertNotIn("rerankCostUsd", output, "flag OFF: no key in the result")
            self.assertNotIn("rerankCostUsd", artifact, "flag OFF: no key in the artifact")
            self.assertNotIn("Rerank cost", md, "flag OFF: no markdown line")

    def test_flag_on_prices_the_metered_usage_end_to_end(self) -> None:
        with mock.patch(
            "agentrail.context.llm_rerank._call_model", side_effect=_reversing_call
        ) as seam:
            output = self._build(model_path=True, **{_FLAG: "1"})
        self.assertTrue(seam.called, "flag ON must route through the single model seam")

        artifact = self._artifact(output)
        llm = ((artifact.get("compiler") or {}).get("rerank") or {}).get("llm") or {}
        self.assertEqual(llm.get("model"), LLM_RERANK_DEFAULT_MODEL)
        self.assertGreaterEqual(llm.get("calls"), 1, "the stage must have actually called the model")

        expected = cost_for(
            llm["model"],
            input_tokens=llm["inputTokens"],
            output_tokens=llm["outputTokens"],
            cached_read=llm["cacheReadInputTokens"],
            cached_write=llm["cacheCreationInputTokens"],
        )["dollars"]
        self.assertGreater(expected, 0.0, "metered usage must price to a nonzero cost")
        self.assertAlmostEqual(artifact["rerankCostUsd"], expected, places=12)
        self.assertEqual(output["rerankCostUsd"], artifact["rerankCostUsd"])

        md = self._markdown(output)
        self.assertIn(
            f"- Rerank cost: ${artifact['rerankCostUsd']:.6f} USD"
            f" (model={llm['model']}, calls={llm['calls']})",
            md,
            "AC3: the rerank-layer cost must appear as its own markdown line",
        )

    def test_flag_on_missing_model_path_fallback_still_reports_cost(self) -> None:
        """Fail-open path: no headless model path means zero usage, but the layer
        ran — the pack must still carry rerankCostUsd (0.0) and render the line."""
        fake = mock.Mock(side_effect=AssertionError("must not hit the network seam"))
        with mock.patch("agentrail.context.llm_rerank._call_model", fake):
            output = self._build(model_path=False, **{_FLAG: "1"})
        fake.assert_not_called()

        artifact = self._artifact(output)
        contract = (artifact.get("compiler") or {}).get("rerank") or {}
        self.assertEqual(contract.get("llmFallback"), "missing_model_path")
        self.assertEqual(artifact.get("rerankCostUsd"), 0.0)
        self.assertEqual(output.get("rerankCostUsd"), 0.0)
        self.assertIn("- Rerank cost: $0.000000 USD", self._markdown(output))


if __name__ == "__main__":
    unittest.main()

"""Harness-path tests for issue #1044 — the Haiku listwise rerank's model call
rides the AUTHENTICATED Claude Code CLI (headless ``claude -p``), NOT a raw
``anthropic.Anthropic()`` + ``ANTHROPIC_API_KEY``.

These tests exercise the ONE network seam (:func:`_call_model`) and its gate at
the harness level:

* the seam shells out to ``claude -p --output-format json --model <m>`` with the
  prompt on stdin and parses the CLI's ``result`` / ``usage`` envelope;
* the gate is "is the headless model path resolvable" (``shutil.which("claude")``),
  and when it is missing the whole stage fails open to the deterministic order
  with a ``missing_model_path`` reason — never a crash;
* any call error (non-zero exit, missing binary, timeout) also fails open;
* flag OFF never touches the seam at all.

No test needs a real ``ANTHROPIC_API_KEY`` or a real ``claude`` process — the
subprocess boundary and the availability check are mocked.
"""
from __future__ import annotations

import json
import os
import subprocess
import unittest
from contextlib import contextmanager
from unittest import mock

from agentrail.context.llm_rerank import (
    LLM_RERANK_DEFAULT_MODEL,
    _call_model,
    _parse_cli_response,
    llm_rerank,
    llm_rerank_cost_usd,
    llm_rerank_enabled,
    resolve_llm_rerank_cli,
)
from agentrail.context.retrieval import query_context

# Reuse the sibling module's repo fixture + helpers so the end-to-end flag-OFF
# assertion runs against the SAME retrieval path the wiring tests use.
from agentrail.tests.context.test_llm_rerank import (
    _FLAG,
    _QUERY,
    _candidates,
    _make_repo,
    _prompt_ids,
)

_ZERO_USAGE = {
    "inputTokens": 0,
    "outputTokens": 0,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
}


@contextmanager
def _env(key: str, value: str | None):
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


def _envelope(result_text: str, *, usage: dict | None = None) -> str:
    """A ``claude -p --output-format json`` stdout body."""
    body: dict = {"type": "result", "result": result_text}
    if usage is not None:
        body["usage"] = usage
    return json.dumps(body)


def _reversing_headless_run(*, usage: dict | None = None):
    """Fake ``subprocess.run`` that reverses the prompt's candidate order and
    returns it inside the CLI JSON envelope (a maximally order-changing reply)."""
    usage = usage or {
        "input_tokens": 123,
        "output_tokens": 45,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 7,
    }

    def _run(argv, *, input, text, capture_output, timeout, env):  # noqa: A002 - stdin kwarg name
        ids = _prompt_ids(input)
        stdout = _envelope(json.dumps(list(reversed(ids))), usage=usage)
        return subprocess.CompletedProcess(argv, 0, stdout=stdout, stderr="")

    return _run


class CallModelSeamTests(unittest.TestCase):
    """The seam rides ``claude -p`` — no anthropic SDK, no ANTHROPIC_API_KEY."""

    def test_call_model_invokes_headless_claude_and_parses_envelope(self) -> None:
        usage = {
            "input_tokens": 100,
            "output_tokens": 12,
            "cache_creation_input_tokens": 3,
            "cache_read_input_tokens": 7,
        }
        captured: dict = {}

        def fake_run(argv, *, input, text, capture_output, timeout, env):  # noqa: A002
            captured["argv"] = argv
            captured["input"] = input
            captured["text"] = text
            captured["capture_output"] = capture_output
            return subprocess.CompletedProcess(
                argv, 0, stdout=_envelope('["c2","c1"]', usage=usage), stderr=""
            )

        with mock.patch("subprocess.run", fake_run):
            text, got_usage = _call_model("claude-haiku-x", "PROMPT-BODY")

        self.assertEqual(text, '["c2","c1"]', "result text comes from the CLI envelope")
        self.assertEqual(
            got_usage,
            {
                "inputTokens": 100,
                "outputTokens": 12,
                "cacheCreationInputTokens": 3,
                "cacheReadInputTokens": 7,
            },
            "usage is mapped verbatim from the CLI envelope",
        )
        # argv is the headless claude -p path with the model + json output format;
        # the prompt rides stdin (never an argv leak of candidate content).
        self.assertEqual(captured["argv"][0], resolve_llm_rerank_cli())
        self.assertIn("-p", captured["argv"])
        self.assertIn("--output-format", captured["argv"])
        self.assertIn("json", captured["argv"])
        self.assertEqual(captured["argv"][-2:], ["--model", "claude-haiku-x"])
        self.assertEqual(captured["input"], "PROMPT-BODY")
        self.assertTrue(captured["text"] and captured["capture_output"])

    def test_call_model_raises_on_nonzero_exit(self) -> None:
        def fake_run(argv, *, input, text, capture_output, timeout, env):  # noqa: A002
            return subprocess.CompletedProcess(argv, 2, stdout="", stderr="model error")

        with mock.patch("subprocess.run", fake_run):
            with self.assertRaises(RuntimeError):
                _call_model("m", "p")

    def test_call_model_does_not_import_anthropic_or_read_api_key(self) -> None:
        # No ANTHROPIC_API_KEY in the environment, yet the call still fires — the
        # authenticated agent (not a raw key) owns auth.
        def fake_run(argv, *, input, text, capture_output, timeout, env):  # noqa: A002
            self.assertNotIn("ANTHROPIC_API_KEY", " ".join(argv))
            return subprocess.CompletedProcess(argv, 0, stdout=_envelope('["c1"]'), stderr="")

        with _env("ANTHROPIC_API_KEY", None), mock.patch("subprocess.run", fake_run):
            text, usage = _call_model("m", "p")
        self.assertEqual(text, '["c1"]')
        self.assertEqual(usage, _ZERO_USAGE, "an envelope without usage meters zero, not a fabricated number")


class ParseCliResponseTests(unittest.TestCase):
    def test_full_envelope_yields_text_and_usage(self) -> None:
        usage = {
            "input_tokens": 5,
            "output_tokens": 6,
            "cache_creation_input_tokens": 1,
            "cache_read_input_tokens": 2,
        }
        text, got = _parse_cli_response(_envelope('["c3","c1","c2"]', usage=usage))
        self.assertEqual(text, '["c3","c1","c2"]')
        self.assertEqual(
            got,
            {"inputTokens": 5, "outputTokens": 6, "cacheCreationInputTokens": 1, "cacheReadInputTokens": 2},
        )

    def test_non_envelope_bodies_degrade_to_raw_text_and_zero_usage(self) -> None:
        # A bare array (not the {"result": ...} envelope), non-JSON, and an
        # envelope missing usage all degrade honestly: raw text, zero usage.
        for stdout in ('["c1","c2"]', "not json at all", json.dumps({"result": "hi"})):
            text, usage = _parse_cli_response(stdout)
            self.assertEqual(usage, _ZERO_USAGE, f"{stdout!r} must meter zero, never fabricate")
        # The bare-array text is preserved verbatim so parse_window_order still runs.
        text, _ = _parse_cli_response('["c1","c2"]')
        self.assertEqual(text, '["c1","c2"]')
        text, _ = _parse_cli_response(json.dumps({"result": "hi"}))
        self.assertEqual(text, "hi")


class LlmRerankHeadlessTests(unittest.TestCase):
    """``llm_rerank`` end to end through the REAL seam with the subprocess and
    the availability check mocked."""

    def test_reorders_through_headless_seam_and_prices_cost(self) -> None:
        candidates = _candidates(3)
        with mock.patch("shutil.which", return_value="/usr/bin/claude"), mock.patch(
            "subprocess.run", _reversing_headless_run()
        ):
            result = llm_rerank(candidates, query="q")
        self.assertIsNone(result["fallback"], "an available path + a good reply must not fall back")
        self.assertTrue(result["changed"], "a reversing reply must flip the order")
        self.assertEqual(result["ordered"], list(reversed(candidates)))
        self.assertEqual(result["llm"]["calls"], 1)
        self.assertEqual(result["llm"]["inputTokens"], 123, "usage is metered from the CLI envelope")
        self.assertEqual(result["llm"]["cacheReadInputTokens"], 7)
        self.assertGreater(
            llm_rerank_cost_usd(result["llm"]), 0.0, "real usage prices to a real (honest) dollar cost"
        )

    def test_missing_headless_path_fails_open(self) -> None:
        candidates = _candidates(4)
        with mock.patch("shutil.which", return_value=None), mock.patch(
            "subprocess.run", side_effect=AssertionError("must not shell out when the path is missing")
        ):
            result = llm_rerank(candidates, query="q")
        self.assertEqual(result["fallback"], "missing_model_path")
        self.assertEqual(result["ordered"], candidates, "the deterministic order stands")
        self.assertEqual(result["llm"]["calls"], 0)

    def test_headless_binary_error_fails_open(self) -> None:
        candidates = _candidates(4)
        with mock.patch("shutil.which", return_value="/usr/bin/claude"), mock.patch(
            "subprocess.run", side_effect=FileNotFoundError("claude: not found")
        ):
            result = llm_rerank(candidates, query="q")
        self.assertEqual(result["fallback"], "api_error:FileNotFoundError")
        self.assertEqual(result["ordered"], candidates)

    def test_headless_timeout_fails_open(self) -> None:
        candidates = _candidates(4)

        def boom(argv, *, input, text, capture_output, timeout, env):  # noqa: A002
            raise subprocess.TimeoutExpired(argv, timeout)

        with mock.patch("shutil.which", return_value="/usr/bin/claude"), mock.patch(
            "subprocess.run", boom
        ):
            result = llm_rerank(candidates, query="q")
        self.assertEqual(result["fallback"], "api_error:TimeoutExpired")
        self.assertEqual(result["ordered"], candidates)

    def test_nonzero_exit_fails_open(self) -> None:
        candidates = _candidates(4)

        def fail(argv, *, input, text, capture_output, timeout, env):  # noqa: A002
            return subprocess.CompletedProcess(argv, 1, stdout="", stderr="auth error")

        with mock.patch("shutil.which", return_value="/usr/bin/claude"), mock.patch(
            "subprocess.run", fail
        ):
            result = llm_rerank(candidates, query="q")
        self.assertEqual(result["fallback"], "api_error:RuntimeError")
        self.assertEqual(result["ordered"], candidates)


class FlagOffHarnessTests(unittest.TestCase):
    """Flag OFF must never reach the headless seam (byte-identical to today)."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.repo = _make_repo()

    def test_flag_defaults_off(self) -> None:
        with _env(_FLAG, None):
            self.assertFalse(llm_rerank_enabled())

    def test_flag_off_never_touches_the_headless_seam(self) -> None:
        seam = mock.Mock(side_effect=AssertionError("the model seam must not run with the flag OFF"))
        with _env("AGENTRAIL_CONTEXT_RERANK", "1"), _env(_FLAG, None), mock.patch(
            "agentrail.context.llm_rerank._call_model", seam
        ):
            output = query_context(self.repo, _QUERY)
        seam.assert_not_called()
        contract = (output.get("compiler") or {}).get("rerank") or {}
        self.assertNotIn("llm", contract, "flag OFF emits no LLM telemetry")
        self.assertNotIn("llmFallback", contract, "flag OFF emits no fallback reason")


if __name__ == "__main__":
    unittest.main()

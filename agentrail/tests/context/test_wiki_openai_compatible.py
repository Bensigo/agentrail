"""Tests for the wiki compiler's ``openai-compatible`` prose provider
(agentrail/context/wiki.py).

Fix 1 of the owner feedback "the wiki has no knowledge in it": the hosted
fleet container carries OPENROUTER_API_KEY and no `claude` binary, so
production compiles previously always fell open to skeleton-only prose. This
adds an ``openai-compatible`` ``context.summary.mode`` -- a chat-completions
POST to an OpenRouter-compatible gateway -- following
``embeddings.run_openai_compatible``'s conventions exactly (baseUrl/
apiKeyEnv indirection via ``ProviderConfig``, a local-host bypass, a bare
``RuntimeError`` on a missing key), but posting CHAT COMPLETIONS (the shape
the fleet's OpenRouter credentials actually serve) instead of embeddings.

No test here touches the real network: every HTTP call is a monkeypatched
``urllib.request.urlopen`` fake, mirroring test_snapshot_push.py's /
test_wiki_push.py's established seam.
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path
from typing import Any, Dict
from unittest import mock

from agentrail.context import wiki
from agentrail.context.config import ProviderConfig
from agentrail.context.index import build_index
from agentrail.tests.context.test_wiki import _env, _wiki_on, make_repo


class _FakeResponse:
    def __init__(self, body: bytes) -> None:
        self._body = body

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *exc: Any) -> bool:
        return False

    def read(self) -> bytes:
        return self._body


def _chat_completion(text: str, *, input_tokens: int = 100, output_tokens: int = 50) -> Dict[str, Any]:
    return {
        "choices": [{"message": {"role": "assistant", "content": text}}],
        "usage": {"prompt_tokens": input_tokens, "completion_tokens": output_tokens},
    }


_PROSE_JSON = json.dumps({"responsibility": "Does things.", "fileNotes": {}, "relationships": "Relates to things."})


# ---------------------------------------------------------------------------
# _call_openai_compatible -- fake HTTP transport (mirrors test_snapshot_push.py)
# ---------------------------------------------------------------------------


class CallOpenAICompatibleRequestShapeTests(unittest.TestCase):
    def test_posts_chat_completions_with_bearer_and_model(self) -> None:
        captured: Dict[str, Any] = {}

        def fake_urlopen(request, timeout=None):
            captured["url"] = request.full_url
            captured["auth"] = request.get_header("Authorization")
            captured["body"] = json.loads(request.data.decode("utf-8"))
            captured["timeout"] = timeout
            return _FakeResponse(json.dumps(_chat_completion(_PROSE_JSON)).encode("utf-8"))

        with _env("OPENROUTER_API_KEY", "or-secret"), mock.patch.object(wiki.urllib.request, "urlopen", fake_urlopen):
            text, usage = wiki._call_openai_compatible(
                "anthropic/claude-haiku-4.5", "prompt text", ProviderConfig(mode="openai-compatible")
            )

        self.assertEqual(captured["url"], "https://openrouter.ai/api/v1/chat/completions")
        self.assertEqual(captured["auth"], "Bearer or-secret")
        self.assertEqual(captured["body"]["model"], "anthropic/claude-haiku-4.5")
        self.assertEqual(captured["body"]["messages"], [{"role": "user", "content": "prompt text"}])
        self.assertEqual(captured["timeout"], wiki._CALL_TIMEOUT_SECONDS)
        self.assertEqual(text, _PROSE_JSON)
        self.assertEqual(usage, {"inputTokens": 100, "outputTokens": 50})

    def test_custom_base_url_and_api_key_env_are_honored(self) -> None:
        captured: Dict[str, Any] = {}

        def fake_urlopen(request, timeout=None):
            captured["url"] = request.full_url
            captured["auth"] = request.get_header("Authorization")
            return _FakeResponse(json.dumps(_chat_completion(_PROSE_JSON)).encode("utf-8"))

        cfg = ProviderConfig(mode="openai-compatible", baseUrl="https://gateway.example.com/v1/", apiKeyEnv="MY_KEY")
        with _env("MY_KEY", "custom-secret"), mock.patch.object(wiki.urllib.request, "urlopen", fake_urlopen):
            wiki._call_openai_compatible("some-model", "prompt", cfg)
        self.assertEqual(captured["url"], "https://gateway.example.com/v1/chat/completions")
        self.assertEqual(captured["auth"], "Bearer custom-secret")

    def test_local_endpoint_bypasses_key_requirement(self) -> None:
        def fake_urlopen(request, timeout=None):
            return _FakeResponse(json.dumps(_chat_completion(_PROSE_JSON)).encode("utf-8"))

        cfg = ProviderConfig(mode="openai-compatible", baseUrl="http://localhost:11434/v1")
        with _env("OPENROUTER_API_KEY", None), mock.patch.object(wiki.urllib.request, "urlopen", fake_urlopen):
            text, _usage = wiki._call_openai_compatible("local-model", "prompt", cfg)
        self.assertEqual(text, _PROSE_JSON)

    def test_missing_key_raises_without_a_network_call(self) -> None:
        def fake_urlopen(request, timeout=None):
            raise AssertionError("must not attempt a network call without a key")

        cfg = ProviderConfig(mode="openai-compatible")
        with _env("OPENROUTER_API_KEY", None), mock.patch.object(wiki.urllib.request, "urlopen", fake_urlopen):
            with self.assertRaises(RuntimeError):
                wiki._call_openai_compatible("some-model", "prompt", cfg)

    def test_malformed_response_missing_choices_raises(self) -> None:
        def fake_urlopen(request, timeout=None):
            return _FakeResponse(json.dumps({"usage": {"prompt_tokens": 1, "completion_tokens": 1}}).encode("utf-8"))

        with _env("OPENROUTER_API_KEY", "k"), mock.patch.object(wiki.urllib.request, "urlopen", fake_urlopen):
            with self.assertRaises(ValueError):
                wiki._call_openai_compatible("some-model", "prompt", ProviderConfig(mode="openai-compatible"))

    def test_missing_usage_defaults_to_zero_tokens(self) -> None:
        def fake_urlopen(request, timeout=None):
            return _FakeResponse(json.dumps({"choices": [{"message": {"content": _PROSE_JSON}}]}).encode("utf-8"))

        with _env("OPENROUTER_API_KEY", "k"), mock.patch.object(wiki.urllib.request, "urlopen", fake_urlopen):
            _text, usage = wiki._call_openai_compatible("some-model", "prompt", ProviderConfig(mode="openai-compatible"))
        self.assertEqual(usage, {"inputTokens": 0, "outputTokens": 0})


# ---------------------------------------------------------------------------
# _call_prose_model dispatch
# ---------------------------------------------------------------------------


class CallProseModelDispatchTests(unittest.TestCase):
    def test_dispatches_openai_compatible_mode(self) -> None:
        with mock.patch.object(wiki, "_call_openai_compatible", return_value=("x", {"inputTokens": 1, "outputTokens": 1})) as fake:
            result = wiki._call_prose_model("openai-compatible", Path("."), ProviderConfig(mode="openai-compatible"), "m", "p")
        fake.assert_called_once_with("m", "p", mock.ANY)
        self.assertEqual(result, ("x", {"inputTokens": 1, "outputTokens": 1}))


# ---------------------------------------------------------------------------
# _openai_compatible_key_present
# ---------------------------------------------------------------------------


class OpenAICompatibleKeyPresentTests(unittest.TestCase):
    def test_true_when_key_set(self) -> None:
        with _env("OPENROUTER_API_KEY", "k"):
            self.assertTrue(wiki._openai_compatible_key_present(ProviderConfig(mode="openai-compatible")))

    def test_false_when_key_absent_and_remote(self) -> None:
        with _env("OPENROUTER_API_KEY", None):
            self.assertFalse(wiki._openai_compatible_key_present(ProviderConfig(mode="openai-compatible")))

    def test_true_for_local_endpoint_regardless_of_key(self) -> None:
        with _env("OPENROUTER_API_KEY", None):
            cfg = ProviderConfig(mode="openai-compatible", baseUrl="http://localhost:11434/v1")
            self.assertTrue(wiki._openai_compatible_key_present(cfg))

    def test_respects_custom_api_key_env(self) -> None:
        with _env("OPENROUTER_API_KEY", None), _env("MY_CUSTOM_KEY", "v"):
            cfg = ProviderConfig(mode="openai-compatible", apiKeyEnv="MY_CUSTOM_KEY")
            self.assertTrue(wiki._openai_compatible_key_present(cfg))


# ---------------------------------------------------------------------------
# _default_prose_model
# ---------------------------------------------------------------------------


class DefaultProseModelTests(unittest.TestCase):
    def test_openai_compatible_reads_env_override(self) -> None:
        with _env(wiki.WIKI_PROSE_MODEL_ENV, "custom/model-x"):
            self.assertEqual(wiki._default_prose_model("openai-compatible"), "custom/model-x")

    def test_openai_compatible_defaults_to_anthropic_haiku(self) -> None:
        with _env(wiki.WIKI_PROSE_MODEL_ENV, None):
            self.assertEqual(wiki._default_prose_model("openai-compatible"), "anthropic/claude-haiku-4.5")

    def test_other_modes_unaffected_by_the_new_env_var(self) -> None:
        with _env(wiki.WIKI_PROSE_MODEL_ENV, "should-not-matter"):
            self.assertEqual(wiki._default_prose_model("claude-cli"), wiki.DEFAULT_PROSE_MODEL)
            self.assertEqual(wiki._default_prose_model("custom-command"), wiki.DEFAULT_PROSE_MODEL)
            self.assertEqual(wiki._default_prose_model("disabled"), wiki.DEFAULT_PROSE_MODEL)


# ---------------------------------------------------------------------------
# _generate_prose: preflight, usage/cost accounting, malformed-response fail-open
# ---------------------------------------------------------------------------


class GeneratePoseOpenAICompatibleTests(unittest.TestCase):
    def test_unavailable_when_key_missing_no_network_attempted(self) -> None:
        def fake_urlopen(request, timeout=None):
            raise AssertionError("must not attempt a network call")

        tracker = wiki._CostTracker(ceiling=1.0)
        cfg = ProviderConfig(mode="openai-compatible")
        with _env("OPENROUTER_API_KEY", None), mock.patch.object(wiki.urllib.request, "urlopen", fake_urlopen):
            parsed, status = wiki._generate_prose(Path("."), cfg, "openai-compatible", "anthropic/claude-haiku-4.5", "prompt", tracker)
        self.assertIsNone(parsed)
        self.assertEqual(status, "unavailable")
        self.assertEqual(tracker.calls, 0)

    def test_known_model_id_prices_normally(self) -> None:
        def fake_urlopen(request, timeout=None):
            return _FakeResponse(json.dumps(_chat_completion(_PROSE_JSON, input_tokens=1000, output_tokens=500)).encode("utf-8"))

        tracker = wiki._CostTracker(ceiling=10.0)
        cfg = ProviderConfig(mode="openai-compatible")
        with _env("OPENROUTER_API_KEY", "k"), mock.patch.object(wiki.urllib.request, "urlopen", fake_urlopen):
            # "claude-haiku-4-5" (no "anthropic/" prefix, hyphenated) IS a
            # real pricing.PRICE_TABLE key -- an operator could point
            # openai-compatible mode at a gateway that uses this house id.
            parsed, status = wiki._generate_prose(Path("."), cfg, "openai-compatible", "claude-haiku-4-5", "prompt", tracker)
        self.assertEqual(status, "ok")
        self.assertIsNotNone(parsed)
        self.assertGreater(tracker.total_usd, 0.0)
        self.assertFalse(tracker.unpriced_model)
        self.assertEqual(tracker.calls, 1)

    def test_unknown_model_id_records_zero_cost_and_flags_unpriced(self) -> None:
        def fake_urlopen(request, timeout=None):
            return _FakeResponse(json.dumps(_chat_completion(_PROSE_JSON, input_tokens=1000, output_tokens=500)).encode("utf-8"))

        tracker = wiki._CostTracker(ceiling=10.0)
        cfg = ProviderConfig(mode="openai-compatible")
        with _env("OPENROUTER_API_KEY", "k"), mock.patch.object(wiki.urllib.request, "urlopen", fake_urlopen):
            # "anthropic/claude-haiku-4.5" (the actual OpenRouter-spelled
            # default) is NOT a pricing.PRICE_TABLE key.
            parsed, status = wiki._generate_prose(Path("."), cfg, "openai-compatible", "anthropic/claude-haiku-4.5", "prompt", tracker)
        self.assertEqual(status, "ok")
        self.assertIsNotNone(parsed)
        self.assertEqual(tracker.total_usd, 0.0)
        self.assertTrue(tracker.unpriced_model)
        self.assertEqual(tracker.calls, 1, "the call still counts even though it is unpriced")

    def test_malformed_response_falls_open_never_crashes(self) -> None:
        def fake_urlopen(request, timeout=None):
            return _FakeResponse(json.dumps(_chat_completion("not json at all, just prose")).encode("utf-8"))

        tracker = wiki._CostTracker(ceiling=10.0)
        cfg = ProviderConfig(mode="openai-compatible")
        with _env("OPENROUTER_API_KEY", "k"), mock.patch.object(wiki.urllib.request, "urlopen", fake_urlopen):
            parsed, status = wiki._generate_prose(Path("."), cfg, "openai-compatible", "claude-haiku-4-5", "prompt", tracker)
        self.assertIsNone(parsed)
        self.assertEqual(status, "error")
        self.assertEqual(tracker.provider_errors, 1)
        self.assertEqual(tracker.calls, 1, "the call succeeded and was priced even though content was unusable")

    def test_network_failure_falls_open_and_is_never_priced(self) -> None:
        def fake_urlopen(request, timeout=None):
            raise OSError("network down")

        tracker = wiki._CostTracker(ceiling=10.0)
        cfg = ProviderConfig(mode="openai-compatible")
        with _env("OPENROUTER_API_KEY", "k"), mock.patch.object(wiki.urllib.request, "urlopen", fake_urlopen):
            parsed, status = wiki._generate_prose(Path("."), cfg, "openai-compatible", "claude-haiku-4-5", "prompt", tracker)
        self.assertIsNone(parsed)
        self.assertEqual(status, "error")
        self.assertEqual(tracker.provider_errors, 1)
        self.assertEqual(tracker.calls, 0, "a call that never completed must not be priced")


# ---------------------------------------------------------------------------
# End-to-end: compile_wiki/build_index wiring (mirrors test_wiki.py's
# FailOpenTests.test_claude_cli_never_shells_out_in_this_test_suite pattern)
# ---------------------------------------------------------------------------


class EndToEndCompileWikiTests(unittest.TestCase):
    def test_openai_compatible_mode_compiles_real_pages_via_fake_call(self) -> None:
        root = make_repo(summary_mode="openai-compatible")
        with _wiki_on(), _env("OPENROUTER_API_KEY", "or-secret"), mock.patch.object(
            wiki, "_call_openai_compatible", return_value=(_PROSE_JSON, {"inputTokens": 10, "outputTokens": 5})
        ) as fake_call:
            result = build_index(root)
        self.assertTrue(fake_call.called)
        report = result["wikiReport"]
        self.assertGreater(report["llmCalls"], 0)
        # The real default model ("anthropic/claude-haiku-4.5") is not in
        # pricing.PRICE_TABLE -- confirms the report is honest ($0 + flag)
        # rather than a fabricated sonnet-class estimate, end to end.
        self.assertTrue(report["unpricedModel"])
        self.assertEqual(report["costUsd"], 0.0)
        overview_text = (wiki.wiki_dir_for(root) / "overview.md").read_text(encoding="utf-8")
        self.assertNotIn("skeleton-only", overview_text)
        self.assertIn("Does things.", overview_text)

    def test_openai_compatible_mode_falls_open_when_key_missing(self) -> None:
        root = make_repo(summary_mode="openai-compatible")
        with _wiki_on(), _env("OPENROUTER_API_KEY", None):
            result = build_index(root)
        report = result["wikiReport"]
        self.assertEqual(report["llmCalls"], 0)
        overview_text = (wiki.wiki_dir_for(root) / "overview.md").read_text(encoding="utf-8")
        self.assertIn("skeleton-only", overview_text)

    def test_openai_compatible_call_reaches_the_real_urlopen_seam(self) -> None:
        """Confirms the wiring reaches ``urllib.request.urlopen`` (not, say,
        a dead branch that never calls out) -- patched here one level lower
        than the other end-to-end tests to prove the exact seam."""
        captured: Dict[str, Any] = {}

        def fake_urlopen(request, timeout=None):
            captured["called"] = True
            captured["url"] = request.full_url
            return _FakeResponse(json.dumps(_chat_completion(_PROSE_JSON)).encode("utf-8"))

        root = make_repo(summary_mode="openai-compatible")
        with _wiki_on(), _env("OPENROUTER_API_KEY", "k"), mock.patch.object(wiki.urllib.request, "urlopen", fake_urlopen):
            result = build_index(root)
        self.assertTrue(captured.get("called"))
        self.assertEqual(captured["url"], "https://openrouter.ai/api/v1/chat/completions")
        self.assertGreater(result["wikiReport"]["llmCalls"], 0)


if __name__ == "__main__":
    unittest.main()

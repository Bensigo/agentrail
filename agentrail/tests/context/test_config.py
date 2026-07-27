"""Tests for agentrail/context/config.py's read_context_config.

Coupling test for the Repo Wiki task-time-context spec, section A
"Configuration" (docs/superpowers/specs/2026-07-27-repo-wiki-task-time-
context-design.md): deploy/runner/agentrail-config.hosted.json is copied
byte-identically into a fresh hosted clone's .agentrail/config.json by
agentrail.sandbox.native_runner._inject_hosted_config whenever that clone
carries none of its own (see that function's docstring) — so THIS file, not
some other config, is what read_context_config()/ContextConfig.summary sees
on a hosted run with no repo-owned config. Before this PR it shipped no
`context` key at all, so ProviderConfig's own default (`mode: "disabled"`)
applied and build_index's wiki branch (gated on
`cfg.summary.mode != "disabled"`, see context/index.py's build_index) was
unreachable regardless of the AGENTRAIL_CONTEXT_REPO_WIKI rollout flag. This
test parses the REAL shipped file (not a fixture copy) so a future edit that
silently removes/disables the summary block fails CI here, the same
convention agentrail/tests/run/test_pricing.py's
test_hosted_config_template_models_all_price_nonzero uses for the
runners.claude.models half of the same file.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from agentrail.context.config import read_context_config

_TEMPLATE_PATH = Path(__file__).resolve().parents[3] / "deploy" / "runner" / "agentrail-config.hosted.json"


class HostedConfigSummaryModeTests(unittest.TestCase):
    def test_shipped_template_has_a_summary_block(self) -> None:
        data = json.loads(_TEMPLATE_PATH.read_text())
        self.assertIn("context", data, "hosted template has no top-level 'context' key")
        self.assertIn("summary", data["context"], "hosted template's context block has no 'summary' key")

    def test_shipped_template_summary_mode_is_not_disabled(self) -> None:
        data = json.loads(_TEMPLATE_PATH.read_text())
        mode = data["context"]["summary"]["mode"]
        self.assertNotEqual(mode, "disabled")

    def test_read_context_config_resolves_non_disabled_summary_mode(self) -> None:
        """End-to-end: seed a fresh clone's .agentrail/config.json with the
        REAL shipped template text (exactly what _inject_hosted_config does)
        and confirm read_context_config()'s ContextConfig.summary.mode comes
        back non-"disabled" — the actual gate build_index's wiki branch
        checks."""
        template_text = _TEMPLATE_PATH.read_text()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config_dir = root / ".agentrail"
            config_dir.mkdir(parents=True)
            (config_dir / "config.json").write_text(template_text)
            cfg = read_context_config(root)
        self.assertNotEqual(cfg.summary.mode, "disabled")
        self.assertEqual(cfg.summary.mode, "claude-cli")


if __name__ == "__main__":
    unittest.main()

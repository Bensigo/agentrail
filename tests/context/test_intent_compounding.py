from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from agentrail.context.retrieval import query_context, search_context


def make_repo(*, memory: str | None = None, stale_memory: str | None = None) -> Path:
    root = Path(tempfile.mkdtemp())
    subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
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
                    "embedding": {"mode": "disabled", "provider": None, "model": None},
                    "summary": {"mode": "disabled", "provider": None, "model": None},
                },
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    (root / "src" / "payments").mkdir(parents=True)
    (root / "src" / "payments" / "rounding_rules.py").write_text(
        "def apply_cent_carry(amount):\n    return amount\n",
        encoding="utf-8",
    )
    (root / "src" / "current").mkdir(parents=True)
    (root / "src" / "current" / "checkout.py").write_text(
        "def active_checkout_guard(order):\n    return order\n",
        encoding="utf-8",
    )
    (root / "src" / "legacy").mkdir(parents=True)
    (root / "src" / "legacy" / "checkout.py").write_text(
        "def archived_checkout_policy(order):\n    return order\n",
        encoding="utf-8",
    )
    (root / "docs" / "notes").mkdir(parents=True)
    for index in range(3):
        (root / "docs" / "notes" / f"refund-drift-{index}.md").write_text(
            "# Refund drift note\n\n"
            + "refund drift historical analysis without implementation target\n" * 40,
            encoding="utf-8",
        )
    if memory is not None or stale_memory is not None:
        (root / "docs" / "memory").mkdir(parents=True)
    if memory is not None:
        (root / "docs" / "memory" / "refund-drift.md").write_text(memory, encoding="utf-8")
    if stale_memory is not None:
        (root / "docs" / "memory" / "stale-checkout.md").write_text(stale_memory, encoding="utf-8")
    return root


class IntentCompoundingTests(unittest.TestCase):
    def test_current_lesson_pre_targets_source_with_smaller_context_budget(self) -> None:
        lesson = """---
kind: lesson
source: issue-771
confidence: high
created_at: 2026-06-15T00:00:00Z
expires_at: 2099-01-01T00:00:00Z
---
# Refund drift lesson

Repeat refund drift work lives in src/payments/rounding_rules.py. Start there before broad search.
"""
        cold = search_context(make_repo(), "refund drift", limit=3)
        warm = search_context(make_repo(memory=lesson), "refund drift", limit=1)

        self.assertNotEqual(cold["results"][0]["path"], "src/payments/rounding_rules.py")
        self.assertEqual(warm["results"][0]["path"], "src/payments/rounding_rules.py")
        self.assertLess(
            warm["runMetadata"]["selectedContextTokens"],
            cold["runMetadata"]["selectedContextTokens"],
        )
        self.assertEqual(
            warm["runMetadata"]["intentCompounding"]["targetPaths"],
            ["src/payments/rounding_rules.py"],
        )

    def test_stale_lesson_does_not_override_current_code(self) -> None:
        stale_lesson = """---
kind: lesson
source: issue-100
confidence: high
created_at: 2024-01-01T00:00:00Z
expires_at: 2024-02-01T00:00:00Z
---
# Old checkout lesson

The active_checkout_guard implementation lives in src/legacy/checkout.py.
"""
        output = query_context(make_repo(stale_memory=stale_lesson), "active_checkout_guard", limit=5)

        self.assertEqual(output["results"][0]["path"], "src/current/checkout.py")
        self.assertNotIn("src/legacy/checkout.py", output["intentCompounding"]["targetPaths"])
        legacy = next((item for item in output["results"] if item["path"] == "src/legacy/checkout.py"), None)
        if legacy is not None:
            self.assertEqual(legacy["score"].get("lessonTargetBoost", 0), 0)
            self.assertNotIn("lesson target", legacy["reason"])


if __name__ == "__main__":
    unittest.main()

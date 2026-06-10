from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from agentrail.context.config import read_context_config
from agentrail.context.embeddings import embedding_preset, setup_embeddings

MOCK_OK = (
    f"{sys.executable} -c "
    "\"import sys,json; sys.stdin.read(); "
    "print(json.dumps({'embedding':[1.0,0.0],'provider':'mock','model':'m'}))\""
)
MOCK_FAIL = f"{sys.executable} -c \"import sys; sys.exit(7)\""


def make_repo() -> Path:
    root = Path(tempfile.mkdtemp())
    subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
    (root / ".agentrail").mkdir()
    (root / ".agentrail" / "config.json").write_text(json.dumps({
        "schemaVersion": 1,
        "context": {
            "includeGlobs": ["**/*"],
            "excludeGlobs": [".git/**"],
            "embedding": {"mode": "disabled", "provider": None, "model": None},
        },
    }, indent=2), encoding="utf-8")
    return root


class EmbeddingPresetTests(unittest.TestCase):
    def test_ollama_preset_is_local_openai_compatible(self) -> None:
        cfg = embedding_preset("ollama")
        self.assertEqual(cfg["mode"], "openai-compatible")
        self.assertIn("localhost:11434", cfg["baseUrl"])
        self.assertEqual(cfg["provider"], "ollama")
        self.assertTrue(cfg["model"])

    def test_openai_preset_targets_openai(self) -> None:
        cfg = embedding_preset("openai")
        self.assertEqual(cfg["mode"], "openai-compatible")
        self.assertIn("api.openai.com", cfg["baseUrl"])
        self.assertEqual(cfg["apiKeyEnv"], "OPENAI_API_KEY")

    def test_custom_preset_requires_command(self) -> None:
        cfg = embedding_preset("custom", command="my-embed")
        self.assertEqual(cfg["mode"], "custom-command")
        self.assertEqual(cfg["customCommand"], "my-embed")
        with self.assertRaises(SystemExit):
            embedding_preset("custom")


class SetupEmbeddingsTests(unittest.TestCase):
    def test_custom_validates_then_writes(self) -> None:
        root = make_repo()
        result = setup_embeddings(root, "custom", command=MOCK_OK, validate=True)
        self.assertTrue(result["validated"])
        self.assertEqual(read_context_config(root).embedding.mode, "custom-command")

    def test_disable_turns_off(self) -> None:
        root = make_repo()
        setup_embeddings(root, "custom", command=MOCK_OK, validate=True)
        setup_embeddings(root, "disable")
        self.assertEqual(read_context_config(root).embedding.mode, "disabled")

    def test_failed_validation_does_not_write_config(self) -> None:
        root = make_repo()
        with self.assertRaises(RuntimeError):
            setup_embeddings(root, "custom", command=MOCK_FAIL, validate=True)
        # Config must remain disabled — never persist a broken provider.
        self.assertEqual(read_context_config(root).embedding.mode, "disabled")


if __name__ == "__main__":
    unittest.main()

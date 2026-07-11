from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from agentrail.context.embeddings import embed_context
from agentrail.context.retrieval import query_context

# Deterministic mock embedder: a chunk/query about authorization (tagged
# 'semtag_authz', or the query phrase 'gain entry') embeds to [1,0]; everything
# else to a near-orthogonal vector. Lets us assert ranking behaviour without a
# real provider.
MOCK = (
    "import sys, json\n"
    "c = json.load(sys.stdin).get('content', '').lower()\n"
    "v = [1.0, 0.0] if ('semtag_authz' in c or 'gain entry' in c) else [0.05, 0.998]\n"
    "print(json.dumps({'embedding': v}))\n"
)


class SemanticBlendTests(unittest.TestCase):
    def make_repo(self, mock_path: Path) -> Path:
        root = Path(tempfile.mkdtemp())
        subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
        (root / ".agentrail").mkdir()
        (root / ".agentrail" / "config.json").write_text(json.dumps({
            "schemaVersion": 1,
            "context": {
                "includeGlobs": ["**/*"],
                "excludeGlobs": [".git/**", ".agentrail/context/**"],
                "maxFileSizeBytes": 262144,
                "skipBinary": True,
                "respectGitIgnore": True,
                "secretRedaction": {"enabled": False, "action": "exclude", "denyGlobs": []},
                "embedding": {"mode": "custom-command", "provider": "mock", "model": "mock-2d",
                              "customCommand": f"{sys.executable} {mock_path}"},
                "summary": {"mode": "disabled", "provider": None, "model": None},
            },
        }, indent=2), encoding="utf-8")
        (root / "src").mkdir()
        # Surface-word decoy: repeats the query words, but is NOT about auth.
        (root / "src" / "report.py").write_text(
            "def render_entry(user):\n"
            "    # entry point for a user; users navigate the system entry by entry\n"
            "    return user_system_entry(user)\n", encoding="utf-8")
        # The real answer: authorization logic, few query words, tagged for the mock.
        (root / "src" / "gatekeeper.py").write_text(
            "# semtag_authz\n"
            "def evaluate(caller):\n"
            "    return caller.role in approved and not expired(caller.ticket)\n", encoding="utf-8")
        return root

    def test_semantic_mode_ranks_meaning_over_surface_words(self) -> None:
        tmp = Path(tempfile.mkdtemp())
        mock_path = tmp / "mock_embed.py"
        mock_path.write_text(MOCK, encoding="utf-8")
        root = self.make_repo(mock_path)
        embed_context(root)
        out = query_context(root, "how does a user gain entry to the system")
        self.assertEqual(out["retrievalMode"], "semantic")
        paths = [r["path"] for r in out["results"]]
        self.assertEqual(paths[0], "src/gatekeeper.py",
                         f"semantic match should outrank the surface-word decoy; got {paths[:3]}")


if __name__ == "__main__":
    unittest.main()

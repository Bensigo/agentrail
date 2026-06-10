"""
Embedding builds must survive oversized chunks: the provider's context window
(e.g. Ollama's runtime num_ctx) is smaller than a few large chunks, and a single
rejected chunk previously aborted the whole `agentrail context embed` run.
"""
from __future__ import annotations

import unittest

from agentrail.context.embeddings import (
    MAX_EMBED_CHARS,
    contextual_embedding_text,
    embedding_input,
)


class EmbeddingInputTruncationTest(unittest.TestCase):
    def test_short_content_is_unchanged(self) -> None:
        text = "def foo():\n    return 1\n"
        self.assertEqual(embedding_input(text), text)

    def test_oversized_content_is_truncated_to_budget(self) -> None:
        text = "x = 1\n" * 5000  # ~30k chars, well over the budget
        out = embedding_input(text)
        self.assertEqual(len(out), MAX_EMBED_CHARS)
        self.assertTrue(text.startswith(out))  # keeps the head (most discriminative)

    def test_boundary_exact_budget_is_unchanged(self) -> None:
        text = "a" * MAX_EMBED_CHARS
        self.assertEqual(embedding_input(text), text)


class ContextualEmbeddingTextTest(unittest.TestCase):
    def test_prepends_structural_header_before_content(self) -> None:
        chunk = {
            "path": "packages/db-postgres/src/queries/index.ts",
            "content": "export async function createWorkspace(...) { ... }",
            "symbol": "createWorkspace",
            "kind": "function",
            "symbolHints": ["createWorkspace"],
            "importHints": ["db", "workspaces", "workspaceMemberships"],
            "headingPath": [],
        }
        out = contextual_embedding_text(chunk, {})
        self.assertTrue(out.startswith("["))
        self.assertIn("file: packages/db-postgres/src/queries/index.ts", out)
        self.assertIn("symbol: createWorkspace (function)", out)
        self.assertIn("imports: db, workspaces, workspaceMemberships", out)
        # the original content is preserved after the header
        self.assertIn(chunk["content"], out)

    def test_uses_heading_path_for_docs(self) -> None:
        chunk = {"path": "CONTEXT.md", "content": "Workspaces are the top-level container.", "headingPath": ["Domain", "Workspaces"]}
        out = contextual_embedding_text(chunk, {})
        self.assertIn("section: Domain > Workspaces", out)

    def test_no_metadata_returns_raw_content(self) -> None:
        chunk = {"content": "plain text"}
        self.assertEqual(contextual_embedding_text(chunk, {}), "plain text")


if __name__ == "__main__":
    unittest.main()

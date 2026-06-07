from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agentrail.context.index import build_index, symbol_aware_code_chunks, code_chunks
from agentrail.context.compiler import extract_anchors
from agentrail.context.evaluation import evaluate_retrieval, format_evaluation_report
from agentrail.context.models import ChunkRecord
from agentrail.context.packs import build_context_pack, explain_context_pack, show_context_pack
from agentrail.context.redaction import redact_text
from agentrail.context.retrieval import query_context
from agentrail.context.sources import inventory_sources, source_record_for_file


class ContextModuleTests(unittest.TestCase):
    def make_repo(self) -> Path:
        root = Path(tempfile.mkdtemp())
        subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
        (root / ".agentrail").mkdir()
        (root / ".agentrail" / "config.json").write_text(json.dumps({
            "schemaVersion": 1,
            "context": {
                "includeGlobs": ["**/*"],
                "excludeGlobs": [".git/**", ".agentrail/context/**", ".agentrail/source/**", ".env", ".env.*", "**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*credentials*", "**/*secret*"],
                "maxFileSizeBytes": 262144,
                "skipBinary": True,
                "respectGitIgnore": True,
                "secretRedaction": {"enabled": True, "action": "exclude", "denyGlobs": [".env", ".env.*", "**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*credentials*", "**/*secret*"]},
                "embedding": {"mode": "disabled", "provider": None, "model": None},
                "summary": {"mode": "disabled", "provider": None, "model": None},
            },
        }, indent=2), encoding="utf-8")
        (root / ".agentrail" / "state.json").write_text(json.dumps({
            "workflow": {
                "activeIssue": 92,
                "activePhase": "execute",
                "goals": [
                    {
                        "id": "issue-92",
                        "kind": "issue",
                        "source": "github:issue/92",
                        "status": "active",
                        "summary": "Modularize context engine",
                        "successCriteria": ["Context pack evidence is cited for issue #92."],
                        "nonGoals": ["Do not include unrelated deployment work."],
                        "activeIssue": 92,
                        "activePullRequest": 44,
                        "activeMilestone": None,
                        "createdAt": "2026-06-04T09:00:00Z",
                        "updatedAt": "2026-06-04T09:10:00Z",
                    },
                    {
                        "id": "issue-11",
                        "kind": "issue",
                        "source": "github:issue/11",
                        "status": "active",
                        "summary": "Unrelated deployment goal",
                        "successCriteria": ["Deploy issue #11."],
                        "nonGoals": [],
                        "activeIssue": 11,
                        "activePullRequest": None,
                        "activeMilestone": None,
                        "createdAt": "2026-06-04T08:00:00Z",
                        "updatedAt": "2026-06-04T08:05:00Z",
                    },
                ],
            }
        }, indent=2), encoding="utf-8")
        (root / "CONTEXT.md").write_text("# Context\n\nIssue #92 context.\n", encoding="utf-8")
        (root / "TASTE.md").write_text("# Taste\n\nDirect and concrete output for #92.\n", encoding="utf-8")
        (root / "docs" / "agents").mkdir(parents=True)
        (root / "docs" / "agents" / "issue-92.md").write_text("# Issue 92\n\nModularize context engine for #92.\n", encoding="utf-8")
        (root / "docs" / "prd").mkdir(parents=True)
        (root / "docs" / "prd" / "context-engine.md").write_text("# Context Engine\n\nContext packs for issue #92 and PR #44.\n", encoding="utf-8")
        (root / "docs" / "memory").mkdir(parents=True)
        (root / "docs" / "memory" / "lesson.md").write_text("---\nkind: lesson\nsource: issue-92\nconfidence: high\ncreated_at: 2026-06-04T09:00:00Z\nexpires_at: 2026-12-31T00:00:00Z\n---\n# Context Pack Lesson\n\nKeep pack evidence cited for issue #92.\n", encoding="utf-8")
        (root / ".agentrail" / "runs" / "issue-92-retry").mkdir(parents=True)
        (root / ".agentrail" / "runs" / "issue-92-retry" / "findings.json").write_text(json.dumps({"issue": 92, "findings": [{"message": "Prior mistake for issue #92: missing citations."}]}, indent=2), encoding="utf-8")
        (root / ".agentrail" / "runs" / "issue-92-blocked").mkdir(parents=True)
        (root / ".agentrail" / "runs" / "issue-92-blocked" / "run.json").write_text(json.dumps({"targetIssue": 92, "status": "blocked", "blockedReason": "Blocked run for issue #92: verifier evidence was missing from the PR body."}, indent=2), encoding="utf-8")
        (root / ".agentrail" / "runs" / "issue-92-blocked" / "notes.md").write_text("# Blocked Notes\n\nIssue #92 blocked because verifier evidence was missing.\n", encoding="utf-8")
        (root / ".agentrail" / "runs" / "issue-11-retry").mkdir(parents=True)
        (root / ".agentrail" / "runs" / "issue-11-retry" / "findings.json").write_text(json.dumps({"issue": 11, "findings": [{"message": "Unrelated deployment mistake for issue #11: missing Kubernetes rollout."}]}, indent=2), encoding="utf-8")
        (root / "docs" / "agents" / "review-fix-92.md").write_text("# [review-fix] PR #44: Missing AC verification\n\nLabels: review-fix, ready-for-agent\nLinked issue: #92\nState: OPEN\n\nExpected correction: map each acceptance criterion to command evidence.\n", encoding="utf-8")
        (root / "docs" / "agents" / "memory-suggestion-92.md").write_text("# [memory-suggestion] PR #44: Do not claim ACs without evidence\n\nLabels: memory-suggestion, ready-for-agent\nLinked issue: #92\nState: OPEN\n\nProposed memory: Future context-pack work must cite verification output for every acceptance criterion.\n", encoding="utf-8")
        (root / "docs" / "memory" / "failure-patterns.md").write_text("# Failure Patterns\n\n## Missing acceptance criteria evidence\n\n- kind: failure-pattern\n- source: issue-92\n- confidence: verified\n- created_at: 2026-06-04\n\nAgents sometimes claim context-pack criteria without command evidence. Prevention: include the command or fixture path that proves each criterion.\n\n## Stale deployment review\n\n- kind: failure-pattern\n- source: issue-11\n- confidence: stale\n- created_at: 2024-01-01\n\nOld deployment review notes should not outrank same-issue context-pack failures.\n", encoding="utf-8")
        (root / "skills" / "backend-api").mkdir(parents=True)
        (root / "skills" / "backend-api" / "SKILL.md").write_text("# Backend API\n\nCLI contract skill for issue #92.\n", encoding="utf-8")
        (root / "docs" / "agents" / "pr-44.md").write_text("# PR 44\n\nPR #44 at /pull/44 reviews context pack generation for issue #92.\n", encoding="utf-8")
        (root / "src").mkdir()
        (root / "src" / "app.py").write_text("def agentrail_context_subject():\n    return 'issue #92'\n", encoding="utf-8")
        (root / ".env").write_text("TOKEN=secret\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(root), "config", "user.email", "agentrail@example.com"], check=True)
        subprocess.run(["git", "-C", str(root), "config", "user.name", "AgentRail Test"], check=True)
        subprocess.run(["git", "-C", str(root), "add", "."], check=True)
        subprocess.run(["git", "-C", str(root), "commit", "--quiet", "-m", "Initial fixture"], check=True)
        return root

    def test_redaction_replaces_secret_values(self) -> None:
        result = redact_text('const apiKey = "sk-test-1234567890abcdef"; password: cleartext')
        self.assertIn("[REDACTED:secret_assignment]", result.text)
        self.assertIn("[REDACTED:password]", result.text)
        self.assertGreaterEqual(len(result.findings), 2)

    def test_anchor_extraction_covers_practical_identifiers_deterministically(self) -> None:
        root = self.make_repo()
        text = "\n".join(
            [
                "issue #92 and PR #44 need agentrail/context/packs.py checked.",
                "Run bash scripts/test-context-query for extract_anchors() and AgentRail::ContextCompiler.",
                "The failing test is tests/context/test_context_modules.py::ContextModuleTests::test_anchor_extraction.",
                "ValueError: context build failed",
                "RuntimeError: context build failed with TOKEN=sk-test-1234567890abcdef",
                "Do not leak .env as an anchor.",
            ]
        )
        first = extract_anchors(text, root=root)
        second = extract_anchors(text, root=root)

        self.assertEqual(first, second)
        anchors = {(anchor["kind"], anchor["normalized"]) for anchor in first}
        self.assertIn(("issue", "#92"), anchors)
        self.assertIn(("pull_request", "PR #44"), anchors)
        self.assertIn(("path", "agentrail/context/packs.py"), anchors)
        self.assertIn(("command", "bash scripts/test-context-query"), anchors)
        self.assertIn(("symbol", "extract_anchors()"), anchors)
        self.assertIn(("symbol", "AgentRail::ContextCompiler"), anchors)
        self.assertIn(("test", "tests/context/test_context_modules.py::ContextModuleTests::test_anchor_extraction"), anchors)
        self.assertIn(("error", "ValueError: context build failed"), anchors)
        for anchor in first:
            value = anchor["value"]
            self.assertNotIn("sk-test", value)
            self.assertNotIn("TOKEN=", value)
            self.assertNotEqual(value, ".env")

    def test_source_inventory_is_callable_without_cli(self) -> None:
        root = self.make_repo()
        records = inventory_sources(root)
        paths = [record.path for record in records]
        self.assertIn("CONTEXT.md", paths)
        self.assertIn("docs/agents/issue-92.md", paths)
        self.assertNotIn(".env", paths)

    def test_index_query_and_pack_are_callable_without_shelling_out(self) -> None:
        root = self.make_repo()
        summary = build_index(root)
        self.assertGreater(summary["indexed"], 0)
        self.assertIn("commitSha", summary)
        self.assertGreater(summary["graphNodes"], 0)
        self.assertGreater(summary["graphEdges"], 0)
        self.assertEqual(summary["ingestionHealth"]["status"], "healthy")
        query = query_context(root, "issue #92 context engine", limit=5)
        self.assertTrue(any(item["path"] == "docs/agents/issue-92.md" for item in query["results"]))
        self.assertEqual(query["compiler"]["contractVersion"], "context-compiler-v1")
        for section in ("anchors", "candidates", "graphExpansion", "policy", "rerank", "tokenPack", "citations", "reasons", "metrics", "compatibility"):
            self.assertIn(section, query["compiler"])
        self.assertEqual(query["compiler"]["tokenPack"]["budget"], {"maxItems": 5, "maxTokens": None})
        self.assertTrue(any(candidate["kind"] == "source_evidence" for candidate in query["compiler"]["candidates"]))
        pack = build_context_pack(root, "issue", 92, "execute")
        self.assertEqual(pack["compiler"]["contractVersion"], "context-compiler-v1")
        self.assertEqual(pack["compiler"]["tokenPack"]["budget"], {"maxItems": 20, "maxTokens": 6000})
        self.assertTrue(any(candidate["kind"] == "procedural_guidance" and candidate["sourceType"] == "skill" for candidate in pack["compiler"]["candidates"]))
        self.assertTrue((root / pack["jsonPath"]).exists())
        self.assertTrue((root / pack["markdownPath"]).exists())

    def test_context_pack_sections_are_auditable(self) -> None:
        root = self.make_repo()
        build_index(root)
        output = build_context_pack(root, "issue", 92, "execute")
        pack = json.loads((root / output["jsonPath"]).read_text(encoding="utf-8"))
        expected_sections = [
            "requiredContext",
            "likelyFiles",
            "likelyDocs",
            "relevantMemory",
            "priorMistakes",
            "activeState",
            "availableTools",
            "availableSkills",
            "excludedContext",
            "openQuestions",
        ]
        for section in expected_sections:
            self.assertIn(section, pack)
        self.assertTrue(any(item["path"] == "CONTEXT.md" for item in pack["requiredContext"]))
        self.assertTrue(any(item["path"] == "src/app.py" for item in pack["likelyFiles"]))
        self.assertTrue(any(item["path"] == "docs/agents/issue-92.md" for item in pack["likelyDocs"]))
        self.assertTrue(any(item["path"] == "docs/memory/lesson.md" for item in pack["relevantMemory"]))
        self.assertTrue(any(item["path"].endswith("findings.json") for item in pack["priorMistakes"]))
        self.assertTrue(any(item["path"].endswith("run.json") for item in pack["priorMistakes"]))
        self.assertTrue(any(item["path"].endswith("notes.md") for item in pack["priorMistakes"]))
        self.assertTrue(any(item["path"] == "docs/agents/review-fix-92.md" for item in pack["priorMistakes"]))
        self.assertTrue(any(item["path"] == "docs/agents/memory-suggestion-92.md" for item in pack["priorMistakes"]))
        self.assertTrue(any(item["path"] == "docs/memory/failure-patterns.md" for item in pack["priorMistakes"]))
        self.assertFalse(any("issue-11-retry" in item["path"] for item in pack["priorMistakes"]))
        self.assertTrue(any(item["path"] == ".agentrail/state.json" for item in pack["activeState"]))
        self.assertTrue(any(item["id"] == "issue-92" for item in pack["goals"]))
        self.assertFalse(any(item["id"] == "issue-11" for item in pack["goals"]))
        self.assertEqual(pack["goal"]["summary"], "Modularize context engine")
        self.assertTrue(any(item["path"] == "skills/backend-api/SKILL.md" for item in pack["availableSkills"]))
        self.assertTrue(pack["availableTools"])
        self.assertTrue(pack["excludedContext"])
        for section in expected_sections:
            for item in pack[section]:
                self.assertTrue(item.get("reason"), f"{section} item missing reason: {item}")
                self.assertTrue(item.get("citation"), f"{section} item missing citation: {item}")
        for item in pack["priorMistakes"]:
            self.assertTrue(item.get("source"), f"prior mistake missing source: {item}")
            self.assertTrue(item.get("whyItMatters"), f"prior mistake missing whyItMatters: {item}")
            self.assertTrue(item.get("preventionGuidance"), f"prior mistake missing preventionGuidance: {item}")
        self.assertEqual(pack["index"]["version"], "context-index-v1")
        self.assertEqual(pack["provider"]["mode"], "disabled")
        self.assertIn("audit", pack)
        self.assertIn("jsonPath", pack["audit"])
        self.assertIn("compiler", pack)
        self.assertEqual(pack["compiler"]["compatibility"]["packIncludedMapTo"], "compiler.tokenPack.selectedCandidateIds")
        self.assertEqual(pack["compiler"]["compatibility"]["packExcludedMapTo"], "compiler.candidates[kind=excluded_context]")
        self.assertEqual(len(pack["compiler"]["tokenPack"]["selectedCandidateIds"]), len(pack["included"]))
        self.assertEqual(pack["compiler"]["metrics"]["citationCoverage"], 1)
        self.assertEqual(pack["compiler"]["metrics"]["reasonCoverage"], 1)
        markdown = (root / output["markdownPath"]).read_text(encoding="utf-8")
        self.assertIn("## Required Context", markdown)
        self.assertIn("## Excluded Context", markdown)

    def test_local_index_emits_deterministic_graph_snapshot_metadata(self) -> None:
        root = self.make_repo()
        build_index(root)
        index = json.loads((root / ".agentrail" / "context" / "index" / "index.json").read_text(encoding="utf-8"))

        snapshot = index["snapshot"]
        self.assertEqual(snapshot["version"], "index-snapshot-v1")
        self.assertIsNotNone(snapshot["commitSha"])
        self.assertTrue(snapshot["sourceHashes"]["src/app.py"].startswith("sha256:"))
        self.assertEqual(snapshot["freshness"]["src/app.py"]["status"], "current")
        self.assertEqual(snapshot["ingestionHealth"]["status"], "healthy")
        self.assertFalse(snapshot["sourceCustody"]["fullSourceUploadAllowed"])
        self.assertFalse(snapshot["sourceCustody"]["snippetUploadAllowed"])

        graph = index["graph"]
        self.assertEqual(graph["version"], "code-graph-v1")
        self.assertEqual(graph["authority"], "deterministic")
        self.assertFalse(graph["llmGeneratedAuthoritative"])
        self.assertFalse(graph["enrichment"]["llmGeneratedAuthoritative"])
        unit_node = next(node for node in graph["nodes"] if node["kind"] == "codebase_unit" and node["path"] == ".")
        file_node = next(node for node in graph["nodes"] if node["kind"] == "file" and node["path"] == "src/app.py")
        chunk_node = next(node for node in graph["nodes"] if node["kind"] == "chunk" and node["path"] == "src/app.py")
        self.assertTrue(any(edge["kind"] == "contains_file" and edge["from"] == unit_node["id"] and edge["to"] == file_node["id"] for edge in graph["edges"]))
        self.assertTrue(any(edge["kind"] == "contains_chunk" and edge["from"] == file_node["id"] and edge["to"] == chunk_node["id"] for edge in graph["edges"]))

    def test_pr_review_pack_show_and_explain_are_callable(self) -> None:
        root = self.make_repo()
        build_index(root)
        output = build_context_pack(root, "pr", 44, "review")
        pack = json.loads((root / output["jsonPath"]).read_text(encoding="utf-8"))
        self.assertEqual(pack["target"], {"kind": "pr", "number": 44, "phase": "review"})
        self.assertTrue(any(item["path"] == "docs/agents/pr-44.md" for item in pack["likelyDocs"]))

        shown = show_context_pack(root, output["packId"])
        self.assertIn("Context Pack: pr #44 review", shown)
        explained = explain_context_pack(root, output["packId"])
        self.assertEqual(explained["packId"], output["packId"])
        self.assertGreater(explained["includedCount"], 0)
        self.assertGreaterEqual(explained["excludedCount"], 1)
        self.assertTrue(explained["sections"]["likelyDocs"])

    def test_retrieval_evaluation_reports_quality_metrics(self) -> None:
        root = self.make_repo()
        fixture = root / "eval-fixtures.json"
        fixture.write_text(json.dumps({
            "schemaVersion": 1,
            "fixtures": [
                {
                    "name": "issue-92-main-path",
                    "task": "issue #92 context engine missing citations src/app.py",
                    "requiredSources": ["docs/agents/issue-92.md", "src/app.py"],
                    "expectedFiles": ["src/app.py"],
                    "expectedDocs": ["docs/agents/issue-92.md"],
                    "expectedMemory": ["docs/memory/lesson.md"],
                    "expectedPriorMistakes": [".agentrail/runs/issue-92-retry/findings.json"],
                    "expectedExcludedSources": [".env"],
                }
            ],
        }), encoding="utf-8")
        report = evaluate_retrieval(root, fixture)
        self.assertTrue(report["passed"], format_evaluation_report(report))
        fixture_report = report["fixtures"][0]
        self.assertEqual(fixture_report["status"], "passed")
        self.assertTrue(fixture_report["metrics"]["requiredSourceInclusion"]["passed"])
        self.assertGreater(fixture_report["metrics"]["recallAt5"], 0)
        self.assertEqual(fixture_report["metrics"]["citationCoverage"], 1)
        self.assertEqual(fixture_report["metrics"]["reasonCoverage"], 1)
        self.assertTrue(fixture_report["metrics"]["budgetMetadataPresence"]["passed"])
        self.assertTrue(fixture_report["metrics"]["staleOrDeniedLeakage"]["passed"])
        self.assertTrue(fixture_report["metrics"]["staleSourceExclusion"]["passed"])
        self.assertTrue(all(item.get("candidateId") for item in fixture_report["topResults"]))

    def test_retrieval_evaluation_fails_when_required_context_is_missed(self) -> None:
        root = self.make_repo()
        fixture = root / "bad-eval-fixtures.json"
        fixture.write_text(json.dumps({
            "fixtures": [
                {
                    "name": "missing-required-source",
                    "task": "issue #92 context engine",
                    "requiredSources": ["docs/agents/missing.md"],
                    "expectedFiles": [],
                    "expectedDocs": ["docs/agents/missing.md"],
                    "expectedMemory": [],
                    "expectedPriorMistakes": [],
                    "expectedExcludedSources": [],
                }
            ],
        }), encoding="utf-8")
        report = evaluate_retrieval(root, fixture)
        self.assertFalse(report["passed"])
        self.assertEqual(report["summary"]["failed"], 1)
        self.assertIn("docs/agents/missing.md", report["fixtures"][0]["metrics"]["requiredSourceInclusion"]["missing"])

    def test_retrieval_evaluation_failures_name_compiler_metric_gaps(self) -> None:
        root = self.make_repo()
        fixture = root / "bad-compiler-eval-fixtures.json"
        fixture.write_text(json.dumps({
            "fixtures": [
                {
                    "name": "bad-compiler-metrics",
                    "task": "issue #102 compiler metric diagnostics",
                    "requiredSources": ["docs/agents/missing-required.md"],
                    "expectedFiles": [],
                    "expectedDocs": ["docs/agents/missing-required.md"],
                    "expectedMemory": [],
                    "expectedPriorMistakes": [],
                    "expectedExcludedSources": ["docs/agents/leaked-denied.md"],
                }
            ],
        }), encoding="utf-8")
        query = {
            "provider": {"mode": "disabled"},
            "retrievalBudget": {"maxItems": 10, "maxTokens": None},
            "results": [
                {
                    "rank": 1,
                    "path": "docs/agents/leaked-denied.md",
                    "chunkId": "chunk:leaked-denied",
                    "score": {"final": 1},
                }
            ],
            "excluded": [],
            "compiler": {
                "tokenPack": {
                    "budget": {"maxItems": 10},
                    "selectedCandidateIds": ["chunk:leaked-denied"],
                },
                "candidates": [
                    {
                        "id": "chunk:leaked-denied",
                        "kind": "source_evidence",
                        "path": "docs/agents/leaked-denied.md",
                        "reason": "No reason recorded.",
                        "policy": {
                            "visibility": "denied",
                            "authority": "denied",
                            "freshness": "current",
                        },
                    }
                ],
                "metrics": {
                    "staleOrDeniedLeakage": {
                        "count": 1,
                        "paths": ["docs/agents/leaked-denied.md"],
                        "items": [{"candidateId": "chunk:leaked-denied", "path": "docs/agents/leaked-denied.md"}],
                    }
                },
            },
        }

        with patch("agentrail.context.evaluation.query_context", return_value=query):
            report = evaluate_retrieval(root, fixture)

        fixture_report = report["fixtures"][0]
        self.assertFalse(report["passed"])
        self.assertIn("docs/agents/missing-required.md", fixture_report["metrics"]["requiredSourceInclusion"]["missing"])
        self.assertEqual(fixture_report["metrics"]["citationCoverage"], 0)
        self.assertEqual(fixture_report["metrics"]["reasonCoverage"], 0)
        self.assertFalse(fixture_report["metrics"]["budgetMetadataPresence"]["passed"])
        self.assertFalse(fixture_report["metrics"]["staleOrDeniedLeakage"]["passed"])
        failures = "\n".join(fixture_report["failures"])
        self.assertIn("missing required sources: docs/agents/missing-required.md", failures)
        self.assertIn("top results missing citations: docs/agents/leaked-denied.md", failures)
        self.assertIn("top results missing reasons: docs/agents/leaked-denied.md", failures)
        self.assertIn("leaked denied/stale sources: docs/agents/leaked-denied.md", failures)
        self.assertIn("missing compiler budget metadata: compiler.tokenPack.budget.maxTokens", failures)


    # ---------------------------------------------------------------------------
    # Symbol-aware hybrid retrieval tests (issue #147)
    # ---------------------------------------------------------------------------

    def _make_source_for_text(self, root: Path, relative_path: str, text: str):
        """Helper: write file and return a SourceRecord for it."""
        full_path = root / relative_path
        full_path.parent.mkdir(parents=True, exist_ok=True)
        full_path.write_text(text, encoding="utf-8")
        from agentrail.shared.fs import sha256_text
        return source_record_for_file(full_path, relative_path, content_hash=sha256_text(text), content=text)

    def test_symbol_aware_chunks_have_symbol_and_kind_fields(self) -> None:
        root = Path(tempfile.mkdtemp())
        py_text = "def retry_with_backoff(fn):\n    pass\n\nclass RetryPolicy:\n    pass\n"
        source = self._make_source_for_text(root, "src/retry.py", py_text)
        chunks = symbol_aware_code_chunks(source, py_text, "src/retry.py")
        symbol_names = {c.symbol for c in chunks if c.symbol}
        self.assertIn("retry_with_backoff", symbol_names)
        self.assertIn("RetryPolicy", symbol_names)
        for chunk in chunks:
            if chunk.symbol:
                self.assertIsNotNone(chunk.kind, f"symbol chunk missing kind: {chunk.symbol}")
                self.assertIn(chunk.kind, {"function", "class", "method"})
                self.assertIn("symbol", chunk.id)
                self.assertIn(chunk.symbol, chunk.citation)

    def test_symbol_chunk_json_includes_symbol_and_kind(self) -> None:
        root = Path(tempfile.mkdtemp())
        js_text = "function loadConfig() {\n  return {};\n}\n"
        source = self._make_source_for_text(root, "src/config.js", js_text)
        chunks = symbol_aware_code_chunks(source, js_text, "src/config.js")
        sym_chunks = [c for c in chunks if c.symbol]
        self.assertTrue(sym_chunks, "expected at least one symbol chunk")
        for chunk in sym_chunks:
            j = chunk.to_json()
            self.assertIn("symbol", j)
            self.assertIn("kind", j)
            self.assertEqual(j["symbol"], chunk.symbol)
            self.assertEqual(j["kind"], chunk.kind)

    def test_parser_failure_falls_back_to_line_window_chunks(self) -> None:
        root = Path(tempfile.mkdtemp())
        # Ruby is not in the supported language list — extracted_symbols returns []
        rb_text = "def unsupported_language\n  puts 'hi'\nend\n"
        source = self._make_source_for_text(root, "src/app.rb", rb_text)
        chunks = symbol_aware_code_chunks(source, rb_text, "src/app.rb")
        # Should fall back to line-window chunks (L1-L...)
        self.assertTrue(chunks, "fallback produced no chunks")
        for chunk in chunks:
            self.assertIsNone(chunk.symbol)
            self.assertIsNone(chunk.kind)
            self.assertIn("#L", chunk.citation)

    def test_preamble_chunk_emitted_before_first_symbol(self) -> None:
        root = Path(tempfile.mkdtemp())
        py_text = "import os\nimport sys\n\ndef main():\n    pass\n"
        source = self._make_source_for_text(root, "src/main.py", py_text)
        chunks = symbol_aware_code_chunks(source, py_text, "src/main.py")
        preamble = next((c for c in chunks if c.citation.endswith("#preamble")), None)
        self.assertIsNotNone(preamble, "preamble chunk expected for lines before first symbol")
        self.assertIn("import os", preamble.content)

    def test_no_stale_chunks_after_file_reindex(self) -> None:
        root = self.make_repo()
        # First index
        build_index(root)
        index_path = root / ".agentrail" / "context" / "index" / "index.json"
        index1 = json.loads(index_path.read_text(encoding="utf-8"))
        app_chunks_1 = [c for c in index1["chunks"] if c["path"] == "src/app.py"]
        app_ids_1 = {c["id"] for c in app_chunks_1}
        self.assertGreater(len(app_ids_1), 0)

        # Modify the file
        new_content = "def new_function():\n    return 'changed'\n"
        (root / "src" / "app.py").write_text(new_content, encoding="utf-8")
        subprocess.run(["git", "-C", str(root), "add", "."], check=True)
        subprocess.run(["git", "-C", str(root), "commit", "--quiet", "-m", "Modify app.py"], check=True)

        # Second index
        build_index(root)
        index2 = json.loads(index_path.read_text(encoding="utf-8"))
        app_chunks_2 = [c for c in index2["chunks"] if c["path"] == "src/app.py"]
        app_ids_2 = {c["id"] for c in app_chunks_2}
        self.assertGreater(len(app_ids_2), 0)

        # Old chunk IDs should be gone (content hash changed, no duplicate stale chunks)
        self.assertNotEqual(app_ids_1, app_ids_2, "chunk IDs should change after file modification")
        stale = app_ids_1 & app_ids_2
        self.assertEqual(len(stale), 0, f"stale duplicate chunk IDs after reindex: {stale}")

    def test_exact_symbol_retrieval_returns_expected_candidates(self) -> None:
        root = self.make_repo()
        build_index(root)
        result = query_context(root, "agentrail_context_subject", limit=10)
        paths = [item["path"] for item in result["results"]]
        self.assertIn("src/app.py", paths, "exact symbol query should return the file containing the symbol")

    def test_retrieval_provenance_fields_in_score(self) -> None:
        root = self.make_repo()
        build_index(root)
        result = query_context(root, "issue #92 context engine", limit=5)
        self.assertTrue(result["results"], "no results returned")
        for item in result["results"]:
            score = item["score"]
            self.assertIn("lexicalScore", score, f"lexicalScore missing from score: {score}")
            self.assertIn("denseScore", score, f"denseScore missing from score: {score}")
            self.assertIn("fusedScore", score, f"fusedScore missing from score: {score}")

    def test_graph_expansion_seeds_from_retrieval_candidates(self) -> None:
        root = self.make_repo()
        build_index(root)
        # src/app.py contains "agentrail_context_subject" — this query strongly BM25-matches that file
        result = query_context(root, "agentrail_context_subject", limit=10)
        seeds = result["compiler"]["graphExpansion"]["startedFromRetrievalSeeds"]
        self.assertIsInstance(seeds, list)
        self.assertIn("src/app.py", seeds)

    def test_graph_expansion_output_is_backward_compatible(self) -> None:
        root = self.make_repo()
        build_index(root)
        result = query_context(root, "issue #92 context engine", limit=5)
        expansion = result["compiler"]["graphExpansion"]
        for field in ("status", "maxHops", "startedFromAnchors", "visited", "addedCandidateIds", "rejected"):
            self.assertIn(field, expansion, f"backward-compat field missing from graphExpansion: {field}")
        self.assertIn("startedFromRetrievalSeeds", expansion)


if __name__ == "__main__":
    unittest.main()

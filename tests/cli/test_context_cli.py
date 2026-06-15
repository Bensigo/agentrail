from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path


def assert_compiler_contract(testcase: unittest.TestCase, compiler: dict, *, expected_budget: dict) -> None:
    testcase.assertEqual(compiler["contractVersion"], "context-compiler-v1")
    for section in (
        "input",
        "anchors",
        "candidates",
        "graphExpansion",
        "policy",
        "rerank",
        "tokenPack",
        "citations",
        "reasons",
        "metrics",
        "compatibility",
    ):
        testcase.assertIn(section, compiler)
    testcase.assertEqual(compiler["tokenPack"]["budget"], expected_budget)
    testcase.assertIn(compiler["graphExpansion"]["status"], {"not_available", "no_strong_anchors", "expanded"})
    testcase.assertEqual(compiler["graphExpansion"]["maxHops"], 2)
    testcase.assertEqual(compiler["rerank"]["status"], "score_sorted")
    testcase.assertTrue(compiler["compatibility"]["legacyFieldsPreserved"])
    testcase.assertFalse(compiler["policy"]["sourceCustody"]["fullSourceUploadAllowed"])
    testcase.assertFalse(compiler["policy"]["sourceCustody"]["snippetUploadAllowed"])
    testcase.assertEqual(compiler["policy"]["deniedSourceHandling"], "excluded_context_only")
    testcase.assertEqual(compiler["metrics"]["citationCoverage"], 1)
    testcase.assertEqual(compiler["metrics"]["reasonCoverage"], 1)


class ContextCliTests(unittest.TestCase):
    def test_context_help_preserves_legacy_usage_contract(self) -> None:
        repo = Path(__file__).resolve().parents[2]
        for args in (["context"], ["context", "-h"], ["context", "--help"]):
            with self.subTest(args=args):
                result = subprocess.run([str(repo / "scripts" / "agentrail"), *args], check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                self.assertEqual(result.returncode, 0)
                self.assertIn("Usage:", result.stdout)
                self.assertIn("agentrail context sources [--target DIR]", result.stdout)
                self.assertIn("agentrail context evaluate FIXTURE [--target DIR] [--json]", result.stdout)
                # Stable command shape; optional flags (e.g. --budget-usd, --model) may be appended.
                self.assertIn("agentrail context build pr NUMBER --phase review", result.stdout)
                self.assertIn("agentrail context show PACK [--target DIR] [--json]", result.stdout)
                self.assertIn("agentrail context explain PACK [--target DIR] [--json]", result.stdout)
                self.assertIn("agentrail context daemon start [--target DIR]", result.stdout)
                self.assertIn("agentrail context daemon stop [--target DIR]", result.stdout)
                self.assertIn("agentrail context daemon status [--target DIR] [--json]", result.stdout)
                self.assertEqual(result.stderr, "")

    def test_unknown_context_command_prints_usage_to_stderr(self) -> None:
        repo = Path(__file__).resolve().parents[2]
        result = subprocess.run([str(repo / "scripts" / "agentrail"), "context", "unknown"], check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertIn("Unknown context command: unknown", result.stderr)
        self.assertIn("Usage:", result.stderr)

    def test_public_agentrail_context_command_uses_python_entrypoint(self) -> None:
        repo = Path(__file__).resolve().parents[2]
        root = Path(tempfile.mkdtemp())
        subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
        subprocess.run([str(repo / "scripts" / "agentrail"), "install", "--target", str(root)], check=True, stdout=subprocess.DEVNULL)
        (root / "docs" / "agents" / "issue-92.md").write_text("# Issue 92\n\nContext command boundary.\n", encoding="utf-8")
        result = subprocess.run([str(repo / "scripts" / "agentrail"), "context", "sources", "--target", str(root)], check=True, stdout=subprocess.PIPE, text=True)
        records = json.loads(result.stdout)
        self.assertTrue(any(record["path"] == "docs/agents/issue-92.md" for record in records))

    def test_context_build_show_and_explain_cli(self) -> None:
        repo = Path(__file__).resolve().parents[2]
        root = Path(tempfile.mkdtemp())
        subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
        subprocess.run([str(repo / "scripts" / "agentrail"), "install", "--target", str(root)], check=True, stdout=subprocess.DEVNULL)
        (root / "docs" / "agents" / "issue-92.md").write_text("# Issue 92\n\nContext pack generation for issue #92.\n", encoding="utf-8")
        (root / "docs" / "agents" / "pr-44.md").write_text("# PR 44\n\nPR #44 at /pull/44 reviews context packs.\n", encoding="utf-8")
        (root / "src").mkdir()
        (root / "src" / "pack.py").write_text("def issue_92_pack():\n    return 'issue #92'\n", encoding="utf-8")

        issue_result = subprocess.run([str(repo / "scripts" / "agentrail"), "context", "build", "issue", "92", "--phase", "execute", "--target", str(root), "--json"], check=True, stdout=subprocess.PIPE, text=True)
        issue_output = json.loads(issue_result.stdout)
        self.assertTrue((root / issue_output["jsonPath"]).exists())
        self.assertTrue((root / issue_output["markdownPath"]).exists())

        pr_result = subprocess.run([str(repo / "scripts" / "agentrail"), "context", "build", "pr", "44", "--phase", "review", "--target", str(root), "--json"], check=True, stdout=subprocess.PIPE, text=True)
        pr_output = json.loads(pr_result.stdout)
        self.assertTrue((root / pr_output["jsonPath"]).exists())

        shown = subprocess.run([str(repo / "scripts" / "agentrail"), "context", "show", pr_output["packId"], "--target", str(root)], check=True, stdout=subprocess.PIPE, text=True)
        self.assertIn("Context Pack: pr #44 review", shown.stdout)
        explained = subprocess.run([str(repo / "scripts" / "agentrail"), "context", "explain", pr_output["packId"], "--target", str(root), "--json"], check=True, stdout=subprocess.PIPE, text=True)
        explanation = json.loads(explained.stdout)
        self.assertEqual(explanation["packId"], pr_output["packId"])
        self.assertIn("likelyDocs", explanation["sections"])

    def test_provider_facing_json_shape_for_context_commands(self) -> None:
        repo = Path(__file__).resolve().parents[2]
        root = Path(tempfile.mkdtemp())
        subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
        subprocess.run([str(repo / "scripts" / "agentrail"), "install", "--target", str(root)], check=True, stdout=subprocess.DEVNULL)
        (root / "CONTEXT.md").write_text("# Context\n\nKeep integrations explicit and observable for issue #83.\n", encoding="utf-8")
        (root / "TASTE.md").write_text("# Taste\n\nCommon actions should be obvious without instructional text.\n", encoding="utf-8")
        (root / "docs" / "agents" / "issue-83.md").write_text("# Issue 83\n\nProvider interface for context query, build, show, and explain.\n", encoding="utf-8")
        (root / "src").mkdir()
        (root / "src" / "provider.py").write_text("def context_provider_surface():\n    return 'issue #83 provider interface'\n", encoding="utf-8")

        query_text = (
            "issue #83 PR #44 provider interface src/provider.py "
            "context_provider_surface() RuntimeError: context build failed "
            "bash scripts/test-context-query "
            "tests/context/test_context_modules.py::ContextModuleTests::test_anchor_extraction"
        )
        query_result = subprocess.run(
            [str(repo / "scripts" / "agentrail"), "context", "query", query_text, "--target", str(root), "--json", "--limit", "3"],
            check=True,
            stdout=subprocess.PIPE,
            text=True,
        )
        query = json.loads(query_result.stdout)
        self.assertEqual(query["command"], "context.query")
        self.assertEqual(query["schemaVersion"], 1)
        self.assertEqual(query["limit"], 3)
        self.assertEqual(query["target"], {"kind": "query", "query": query_text})
        self.assertIn("provider", query)
        self.assertIn("audit", query)
        assert_compiler_contract(self, query["compiler"], expected_budget={"maxItems": 3, "maxTokens": None})
        query_anchors = {(anchor["kind"], anchor["normalized"]) for anchor in query["compiler"]["anchors"]}
        self.assertIn(("issue", "#83"), query_anchors)
        self.assertIn(("pull_request", "PR #44"), query_anchors)
        self.assertIn(("path", "src/provider.py"), query_anchors)
        self.assertIn(("symbol", "context_provider_surface()"), query_anchors)
        self.assertIn(("command", "bash scripts/test-context-query"), query_anchors)
        self.assertIn(("test", "tests/context/test_context_modules.py::ContextModuleTests::test_anchor_extraction"), query_anchors)
        self.assertIn(("error", "RuntimeError: context build failed"), query_anchors)
        self.assertEqual(query["compiler"]["input"]["kind"], "query")
        self.assertEqual(query["compiler"]["compatibility"]["queryResultsMapTo"], "compiler.candidates[kind=source_evidence]")
        self.assertTrue(query["results"])
        self.assertEqual(len([candidate for candidate in query["compiler"]["candidates"] if candidate["kind"] == "source_evidence"]), len(query["results"]))
        for item in query["results"]:
            self.assertIn("path", item)
            self.assertIn("citation", item)
            self.assertIn("reason", item)
            self.assertIn("score", item)
        for candidate in query["compiler"]["candidates"]:
            self.assertIn(candidate["kind"], {"source_evidence", "excluded_context"})
            self.assertIn("citation", candidate)
            self.assertIn("reason", candidate)
            self.assertIn("policy", candidate)

        build_result = subprocess.run(
            [str(repo / "scripts" / "agentrail"), "context", "build", "issue", "83", "--phase", "execute", "--target", str(root), "--json"],
            check=True,
            stdout=subprocess.PIPE,
            text=True,
        )
        built = json.loads(build_result.stdout)
        self.assertEqual(built["command"], "context.build")
        self.assertEqual(built["target"], {"kind": "issue", "number": 83, "phase": "execute"})
        self.assertIn("provider", built)
        self.assertIn("audit", built)
        assert_compiler_contract(self, built["compiler"], expected_budget={"maxItems": 20, "maxTokens": 6000})
        self.assertEqual(built["compiler"]["input"]["kind"], "issue")
        self.assertTrue(any(anchor["kind"] == "issue" and anchor["source"] == "target" and anchor["normalized"] == "#83" for anchor in built["compiler"]["anchors"]))
        self.assertEqual(built["compiler"]["compatibility"]["packIncludedMapTo"], "compiler.tokenPack.selectedCandidateIds")
        self.assertTrue((root / built["jsonPath"]).exists())
        saved_pack = json.loads((root / built["jsonPath"]).read_text(encoding="utf-8"))
        self.assertEqual(saved_pack["compiler"]["anchors"], built["compiler"]["anchors"])

        show_result = subprocess.run(
            [str(repo / "scripts" / "agentrail"), "context", "show", built["packId"], "--target", str(root), "--json"],
            check=True,
            stdout=subprocess.PIPE,
            text=True,
        )
        shown = json.loads(show_result.stdout)
        self.assertEqual(shown["command"], "context.show")
        self.assertEqual(shown["packId"], built["packId"])
        self.assertEqual(shown["target"], {"kind": "issue", "number": 83, "phase": "execute"})
        assert_compiler_contract(self, shown["compiler"], expected_budget={"maxItems": 20, "maxTokens": 6000})
        self.assertEqual(shown["compiler"]["anchors"], built["compiler"]["anchors"])
        self.assertIn("included", shown)
        self.assertTrue(all(item.get("citation") and item.get("reason") for item in shown["included"]))
        self.assertTrue(any(candidate["kind"] == "procedural_guidance" and candidate["sourceType"] == "skill" for candidate in shown["compiler"]["candidates"]))
        self.assertTrue(any(candidate["kind"] == "procedural_guidance" and candidate["sourceType"] == "tool" for candidate in shown["compiler"]["candidates"]))
        self.assertEqual(len(shown["compiler"]["tokenPack"]["selectedCandidateIds"]), len(shown["included"]))

        explain_result = subprocess.run(
            [str(repo / "scripts" / "agentrail"), "context", "explain", built["packId"], "--target", str(root), "--json"],
            check=True,
            stdout=subprocess.PIPE,
            text=True,
        )
        explained = json.loads(explain_result.stdout)
        self.assertEqual(explained["command"], "context.explain")
        self.assertEqual(explained["packId"], built["packId"])
        self.assertEqual(explained["target"], {"kind": "issue", "number": 83, "phase": "execute"})
        self.assertIn("sections", explained)
        for section in ("requiredContext", "likelyFiles", "likelyDocs", "excludedContext"):
            self.assertIn(section, explained["sections"])

    def test_compiler_policy_budget_and_denied_sources_from_cli(self) -> None:
        repo = Path(__file__).resolve().parents[2]
        root = Path(tempfile.mkdtemp())
        subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
        subprocess.run([str(repo / "scripts" / "agentrail"), "install", "--target", str(root)], check=True, stdout=subprocess.DEVNULL)
        (root / "docs" / "agents" / "issue-101.md").write_text("# Issue 101\n\nPolicy and token budget metadata for issue #101.\n", encoding="utf-8")
        (root / "src").mkdir()
        (root / "src" / "policy.py").write_text("def issue_101_policy_surface():\n    return 'issue #101 policy metadata'\n", encoding="utf-8")
        (root / "denied").mkdir()
        (root / "denied" / "notes.md").write_text("forbidden-101-denied-secret\n", encoding="utf-8")
        (root / ".env").write_text("ENV_SHOULD_NOT_LEAK=hidden\n", encoding="utf-8")
        config_path = root / ".agentrail" / "config.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        config["context"]["excludeGlobs"] = [*config["context"]["excludeGlobs"], "denied/**"]
        config["context"]["externalSources"] = [
            {
                "id": "external:issue-101-policy",
                "uri": "external://issue-101-policy",
                "authority": "low",
                "visibility": "metadata-only",
                "linkedIssues": [101],
                "token": "ghp_1234567890abcdefghijklmnopqrstuv",
                "note": "policy metadata source for issue #101",
            },
            {
                "id": "external:issue-101-denied",
                "uri": "external://issue-101-denied",
                "authority": "denied",
                "visibility": "denied",
                "linkedIssues": [101],
                "note": "denied source descriptor metadata",
            },
        ]
        config_path.write_text(json.dumps(config, indent=2), encoding="utf-8")

        query_result = subprocess.run(
            [str(repo / "scripts" / "agentrail"), "context", "query", "issue #101 policy budget metadata", "--target", str(root), "--json", "--limit", "5"],
            check=True,
            stdout=subprocess.PIPE,
            text=True,
        )
        self.assertNotIn("forbidden-101-denied-secret", query_result.stdout)
        self.assertNotIn("ENV_SHOULD_NOT_LEAK", query_result.stdout)
        query = json.loads(query_result.stdout)
        self.assertEqual(query["retrievalBudget"], {"maxItems": 5, "maxTokens": None})
        self.assertEqual(query["compiler"]["tokenPack"]["budget"], query["retrievalBudget"])
        self.assertTrue(all(item.get("citation") and item.get("reason") for item in query["results"] + query["excluded"]))
        excluded_candidates = [candidate for candidate in query["compiler"]["candidates"] if candidate["kind"] == "excluded_context"]
        self.assertTrue(excluded_candidates)
        excluded_ids = [candidate["id"] for candidate in excluded_candidates]
        self.assertEqual(len(excluded_ids), len(set(excluded_ids)))
        denied = next(candidate for candidate in excluded_candidates if candidate.get("path") == "external://issue-101-denied")
        self.assertEqual(denied["policy"]["visibility"], "denied")
        self.assertEqual(denied["policy"]["authority"], "denied")
        self.assertEqual(denied["policy"]["authorityPolicy"]["effect"], "excluded")
        self.assertEqual(denied["policy"]["sourceCustody"]["mode"], "metadata_only")
        self.assertFalse(denied["policy"]["sourceCustody"]["fullSourceUploadAllowed"])
        self.assertFalse(denied["policy"]["sourceCustody"]["snippetUploadAllowed"])
        self.assertFalse(denied["policy"]["sourceCustody"]["snippetUploadEligible"])
        for candidate in query["compiler"]["candidates"]:
            policy = candidate["policy"]
            self.assertIn("sourceCustody", policy)
            self.assertFalse(policy["sourceCustody"]["snippetUploadEligible"])
            self.assertIn("redaction", policy)
            self.assertIn(policy["redaction"]["state"], {"none", "redacted", "excluded"})
            self.assertIn("authorityPolicy", policy)
            self.assertIn(policy["authorityPolicy"]["effect"], {"boosted", "neutral", "demoted", "excluded"})
            self.assertIn("freshnessPolicy", policy)
            self.assertIn(policy["freshnessPolicy"]["effect"], {"neutral", "demoted", "excluded"})

        build_result = subprocess.run(
            [str(repo / "scripts" / "agentrail"), "context", "build", "issue", "101", "--phase", "execute", "--target", str(root), "--json"],
            check=True,
            stdout=subprocess.PIPE,
            text=True,
        )
        self.assertNotIn("forbidden-101-denied-secret", build_result.stdout)
        built = json.loads(build_result.stdout)
        self.assertEqual(built["retrievalBudget"], {"maxItems": 20, "maxTokens": 6000})
        self.assertEqual(built["compiler"]["tokenPack"]["budget"], built["retrievalBudget"])
        saved_pack_text = (root / built["jsonPath"]).read_text(encoding="utf-8")
        self.assertNotIn("forbidden-101-denied-secret", saved_pack_text)
        self.assertNotIn("ENV_SHOULD_NOT_LEAK", saved_pack_text)
        saved_pack = json.loads(saved_pack_text)
        self.assertEqual(saved_pack["retrievalBudget"], built["retrievalBudget"])
        self.assertTrue(all(item.get("citation") and item.get("reason") for item in saved_pack["included"] + saved_pack["excluded"]))

    def test_context_evaluate_cli_reports_fixture_metrics(self) -> None:
        repo = Path(__file__).resolve().parents[2]
        root = Path(tempfile.mkdtemp())
        subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
        subprocess.run([str(repo / "scripts" / "agentrail"), "install", "--target", str(root)], check=True, stdout=subprocess.DEVNULL)
        (root / "docs" / "agents" / "issue-84.md").write_text("# Issue 84\n\nRetrieval evaluation for issue #84.\n", encoding="utf-8")
        (root / "src").mkdir()
        (root / "src" / "retrieval_eval.py").write_text("def issue_84_eval():\n    return 'issue #84 retrieval evaluation'\n", encoding="utf-8")
        fixture = root / "fixtures.json"
        fixture.write_text(json.dumps({
            "fixtures": [
                {
                    "name": "issue-84-cli",
                    "task": "issue #84 retrieval evaluation src/retrieval_eval.py",
                    "requiredSources": ["docs/agents/issue-84.md", "src/retrieval_eval.py"],
                    "expectedFiles": ["src/retrieval_eval.py"],
                    "expectedDocs": ["docs/agents/issue-84.md"],
                    "expectedMemory": [],
                    "expectedPriorMistakes": [],
                    "expectedExcludedSources": [".env"],
                }
            ],
        }), encoding="utf-8")
        result = subprocess.run(
            [str(repo / "scripts" / "agentrail"), "context", "evaluate", str(fixture), "--target", str(root), "--json"],
            check=True,
            stdout=subprocess.PIPE,
            text=True,
        )
        report = json.loads(result.stdout)
        self.assertEqual(report["command"], "context.evaluate")
        self.assertTrue(report["passed"])
        self.assertEqual(report["summary"]["passed"], 1)
        self.assertIn("recallAt5", report["fixtures"][0]["metrics"])
        self.assertIn("reasonCoverage", report["fixtures"][0]["metrics"])
        self.assertIn("budgetMetadataPresence", report["fixtures"][0]["metrics"])
        self.assertIn("staleOrDeniedLeakage", report["fixtures"][0]["metrics"])
        self.assertTrue(report["fixtures"][0]["metrics"]["budgetMetadataPresence"]["passed"])
        self.assertTrue(report["fixtures"][0]["topResults"][0]["candidateId"])


class ContextMarkerTests(unittest.TestCase):
    """#519: context query/search touch the context-first marker file."""

    def _install(self) -> Path:
        repo = Path(__file__).resolve().parents[2]
        root = Path(tempfile.mkdtemp())
        subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
        subprocess.run(
            [str(repo / "scripts" / "agentrail"), "install", "--target", str(root)],
            check=True, stdout=subprocess.DEVNULL,
        )
        (root / "src").mkdir(exist_ok=True)
        (root / "src" / "thing.py").write_text("def thing():\n    return 'thing'\n", encoding="utf-8")
        return root

    def test_query_writes_marker(self):
        repo = Path(__file__).resolve().parents[2]
        root = self._install()
        marker = root / ".agentrail" / "tmp" / "context-queried"
        self.assertFalse(marker.exists())
        subprocess.run(
            [str(repo / "scripts" / "agentrail"), "context", "query", "thing", "--target", str(root), "--json"],
            check=True, stdout=subprocess.DEVNULL,
        )
        self.assertTrue(marker.exists())

    def test_search_writes_marker(self):
        repo = Path(__file__).resolve().parents[2]
        root = self._install()
        marker = root / ".agentrail" / "tmp" / "context-queried"
        self.assertFalse(marker.exists())
        subprocess.run(
            [str(repo / "scripts" / "agentrail"), "context", "search", "thing", "--target", str(root), "--json"],
            check=True, stdout=subprocess.DEVNULL,
        )
        self.assertTrue(marker.exists())

    def test_ast_writes_marker(self):
        repo = Path(__file__).resolve().parents[2]
        root = self._install()
        marker = root / ".agentrail" / "tmp" / "context-queried"
        self.assertFalse(marker.exists())
        subprocess.run(
            [str(repo / "scripts" / "agentrail"), "context", "ast", "(function_definition)", "--target", str(root), "--json"],
            check=True, stdout=subprocess.DEVNULL,
        )
        self.assertTrue(marker.exists())


if __name__ == "__main__":
    unittest.main()

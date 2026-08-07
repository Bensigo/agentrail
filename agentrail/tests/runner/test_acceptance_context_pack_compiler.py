"""Hermetic smoke tests for the disposable Acceptance Context Pack worker."""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from agentrail.runner.acceptance_context_pack_compiler import (
    ClaimedCompilation,
    Response,
    WorkerConfig,
    compile_claim,
    run_once,
)


ITEM = ClaimedCompilation(
    id="compilation-1", record_id="record-1", phase="execute", repo_url="https://github.com/ada/widgets",
    ref="main", github_token="secret-token", contract={"goal": "save", "acceptanceCriteria": [{"id": "saved"}]},
)
CONFIG = WorkerConfig(base_url="https://console.example", token="jace-secret", worker_id="worker-1")


class AcceptanceContextPackCompilerTests(unittest.TestCase):
    def test_real_local_clone_index_compile_and_metadata_report(self) -> None:
        source = Path(tempfile.mkdtemp())
        checkout = Path(tempfile.mkdtemp())
        shutil.rmtree(checkout)
        self.addCleanup(lambda: shutil.rmtree(source, ignore_errors=True))
        (source / ".agentrail").mkdir()
        (source / ".agentrail" / "config.json").write_text(json.dumps({
            "schemaVersion": 1,
            "context": {
                "includeGlobs": ["**/*"], "excludeGlobs": [".git/**", ".agentrail/context/**", ".env", ".env.*"],
                "maxFileSizeBytes": 262144, "skipBinary": True, "respectGitIgnore": True,
                "secretRedaction": {"enabled": True, "action": "exclude", "denyGlobs": [".env", ".env.*"]},
                "embedding": {"mode": "disabled", "provider": None, "model": None},
                "summary": {"mode": "disabled", "provider": None, "model": None},
            },
        }), encoding="utf-8")
        (source / "CONTEXT.md").write_text("# Context\n\nThe saved value must remain visible.\n", encoding="utf-8")
        (source / "src").mkdir()
        (source / "src" / "save.py").write_text("def save():\n    return 'saved'\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(source), "init", "--quiet", "--initial-branch=main"], check=True)
        subprocess.run(["git", "-C", str(source), "add", "."], check=True)
        subprocess.run(["git", "-C", str(source), "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "--quiet", "-m", "fixture"], check=True)
        reports: list[dict[str, object]] = []
        def transport(_method: str, _url: str, *, headers: dict[str, str], body: bytes | None = None) -> Response:
            reports.append(json.loads((body or b"{}").decode("utf-8")))
            return Response(status=200, body=b"{}")
        local_item = ClaimedCompilation(
            id="real-compiler-1", record_id="record-real", phase="execute", repo_url=str(source), ref="main",
            github_token="", contract={"goal": "make saved visible", "acceptanceCriteria": [{"id": "saved", "text": "saved is visible"}], "nonGoals": []},
        )
        self.assertTrue(compile_claim(local_item, CONFIG, transport=transport, work_dir_factory=lambda: str(checkout)))
        self.assertEqual(reports[0]["status"], "compiled")
        self.assertTrue(reports[0]["manifest"]["sources"])  # type: ignore[index]
        self.assertTrue(reports[0]["manifest"]["sources"][0]["reason"])  # type: ignore[index]
        self.assertEqual(reports[0]["freshness"]["repositoryRef"], "main")  # type: ignore[index]
        self.assertNotIn("content", reports[0]["manifest"]["sources"][0])  # type: ignore[index]
        self.assertFalse(checkout.exists())

    def test_compiles_only_the_claimed_ref_reports_metadata_and_removes_checkout(self) -> None:
        root = Path(tempfile.mkdtemp())
        calls: dict[str, object] = {}

        def clone(url: str, ref: str, dest: str, *, token: str) -> None:
            calls["clone"] = (url, ref, token)
            Path(dest).mkdir(parents=True)

        def compile_fn(repo: Path, target_kind: str, record_id: str, phase: str, **kwargs: object) -> dict[str, object]:
            calls["compile"] = (repo, target_kind, record_id, phase, kwargs["acceptance_contract"])
            return {"packId": "pack-1", "compilerVersion": "compiler-v1", "contentHash": f"sha256:{'a' * 64}"}

        reports: list[dict[str, object]] = []
        def transport(_method: str, _url: str, *, headers: dict[str, str], body: bytes | None = None) -> Response:
            reports.append(json.loads((body or b"{}").decode("utf-8")))
            return Response(status=200, body=b"{}", headers={})

        ok = compile_claim(
            ITEM, CONFIG, transport=transport, clone_fn=clone, index_fn=lambda repo: calls.setdefault("index", repo),
            compile_fn=compile_fn, load_pack_fn=lambda _repo, _id: {"local": "pack"},
            manifest_fn=lambda _pack, _contract, *, repository_ref: {"manifest": {"tokenBudget": 1, "tokenCount": 1, "sources": [{"path": "a", "citation": "a:1", "startLine": 1, "endLine": 1, "reason": "selected for the claimed task"}], "acceptanceCriteria": [{"id": "saved"}], "architectureBoundaries": [], "tests": [], "decisions": [], "exclusions": []}, "custody": {"fullSourceUploadAllowed": False}, "freshness": {"indexRevision": "sha", "repositoryRef": repository_ref, "compiledAt": "2026-08-06T00:00:00Z"}},
            work_dir_factory=lambda: str(root),
        )
        self.assertTrue(ok)
        self.assertEqual(calls["clone"], (ITEM.repo_url, "main", "secret-token"))
        self.assertEqual(calls["compile"][1:4], ("acceptance_record", "record-1", "execute"))  # type: ignore[index]
        self.assertEqual(reports[0]["status"], "compiled")
        self.assertIsNone(reports[0]["jsonArtifactRef"])
        self.assertFalse(root.exists())

    def test_clone_failure_reports_redacted_failure_and_removes_checkout(self) -> None:
        root = Path(tempfile.mkdtemp())
        reports: list[dict[str, object]] = []
        def transport(_method: str, _url: str, *, headers: dict[str, str], body: bytes | None = None) -> Response:
            reports.append(json.loads((body or b"{}").decode("utf-8")))
            return Response(status=200, body=b"{}", headers={})
        ok = compile_claim(ITEM, CONFIG, transport=transport, clone_fn=lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("secret-token denied")), work_dir_factory=lambda: str(root))
        self.assertTrue(ok)
        self.assertEqual(reports[0]["status"], "failed")
        self.assertNotIn("secret-token", reports[0]["reason"])
        self.assertFalse(root.exists())

    def test_empty_claim_does_not_compile_or_report(self) -> None:
        calls: list[str] = []
        def transport(_method: str, _url: str, *, headers: dict[str, str], body: bytes | None = None) -> Response:
            calls.append("claim")
            return Response(status=204, body=b"", headers={})
        self.assertFalse(run_once(CONFIG, transport=transport))
        self.assertEqual(calls, ["claim"])

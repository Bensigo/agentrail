"""Unit tests for agentrail/run/artifacts.py.

Verifies that each artifact writer produces JSON with the correct field names
and values as consumed by downstream tooling.  No external I/O beyond a
temporary directory — all writes use the real write_json / read_json helpers.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from agentrail.run.artifacts import (
    write_run_metadata,
    update_run_metadata_attempts,
    write_phase_status,
    write_phase_metadata,
)


def _read(path: Path) -> dict:
    with path.open() as fh:
        return json.load(fh)


class WriteRunMetadataTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "run.json"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _write(self, **overrides):
        defaults = dict(
            started_at="2026-06-10T12:00:00Z",
            issue=42,
            agent="claude",
            command="claude -p --dangerously-skip-permissions",
            prompt_file="/tmp/prompt.md",
            resolved_skills_file="/tmp/skills.json",
            resolved_skills=[{"name": "foo"}],
            max_execution_attempts=5,
            context_pack_file="/tmp/ctx.tar.gz",
            context_retrieval={"chunks": 3},
        )
        defaults.update(overrides)
        write_run_metadata(self.path, **defaults)

    def test_all_fields_present(self) -> None:
        self._write()
        data = _read(self.path)
        self.assertEqual(data["startedAt"], "2026-06-10T12:00:00Z")
        self.assertEqual(data["targetType"], "issue")
        self.assertEqual(data["targetIssue"], 42)
        self.assertEqual(data["agent"], "claude")
        self.assertEqual(data["command"], "claude -p --dangerously-skip-permissions")
        self.assertEqual(data["executionAttempt"], 1)
        self.assertEqual(data["maxExecutionAttempts"], 5)
        self.assertEqual(data["failedVerificationAttempts"], 0)
        self.assertEqual(data["promptFile"], "/tmp/prompt.md")
        self.assertEqual(data["contextPackFile"], "/tmp/ctx.tar.gz")
        self.assertEqual(data["contextRetrieval"], {"chunks": 3})
        self.assertEqual(data["resolvedSkillsFile"], "/tmp/skills.json")
        self.assertEqual(data["resolvedSkills"], [{"name": "foo"}])

    def test_target_type_is_issue_string(self) -> None:
        self._write()
        data = _read(self.path)
        self.assertEqual(data["targetType"], "issue")

    def test_execution_attempt_starts_at_1(self) -> None:
        self._write()
        data = _read(self.path)
        self.assertEqual(data["executionAttempt"], 1)

    def test_failed_verification_attempts_starts_at_0(self) -> None:
        self._write()
        data = _read(self.path)
        self.assertEqual(data["failedVerificationAttempts"], 0)

    def test_context_retrieval_defaults_to_empty_dict(self) -> None:
        self._write(context_retrieval={})
        data = _read(self.path)
        self.assertEqual(data["contextRetrieval"], {})

    def test_context_pack_file_none(self) -> None:
        self._write(context_pack_file=None)
        data = _read(self.path)
        self.assertIsNone(data["contextPackFile"])


class UpdateRunMetadataAttemptsTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "run.json"
        write_run_metadata(
            self.path,
            started_at="2026-06-10T12:00:00Z",
            issue=7,
            agent="claude",
            command="claude -p",
            prompt_file="/tmp/p.md",
            resolved_skills_file="/tmp/s.json",
            resolved_skills=[],
            max_execution_attempts=5,
            context_pack_file=None,
            context_retrieval={},
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_updates_attempt_counters(self) -> None:
        update_run_metadata_attempts(
            self.path,
            execution_attempt=2,
            max_execution_attempts=5,
            failed_verification_attempts=1,
        )
        data = _read(self.path)
        self.assertEqual(data["executionAttempt"], 2)
        self.assertEqual(data["maxExecutionAttempts"], 5)
        self.assertEqual(data["failedVerificationAttempts"], 1)

    def test_preserves_other_fields(self) -> None:
        update_run_metadata_attempts(
            self.path,
            execution_attempt=2,
            max_execution_attempts=5,
            failed_verification_attempts=1,
        )
        data = _read(self.path)
        self.assertEqual(data["agent"], "claude")
        self.assertEqual(data["targetIssue"], 7)
        self.assertEqual(data["startedAt"], "2026-06-10T12:00:00Z")

    def test_verifier_findings_file_absent_when_empty(self) -> None:
        update_run_metadata_attempts(
            self.path,
            execution_attempt=2,
            max_execution_attempts=5,
            failed_verification_attempts=1,
            verifier_findings_file="",
        )
        data = _read(self.path)
        self.assertNotIn("verifierFindingsFile", data)

    def test_verifier_findings_file_present_when_set(self) -> None:
        update_run_metadata_attempts(
            self.path,
            execution_attempt=2,
            max_execution_attempts=5,
            failed_verification_attempts=1,
            verifier_findings_file="/tmp/findings.json",
        )
        data = _read(self.path)
        self.assertEqual(data["verifierFindingsFile"], "/tmp/findings.json")

    def test_blocked_reason_absent_when_empty(self) -> None:
        update_run_metadata_attempts(
            self.path,
            execution_attempt=2,
            max_execution_attempts=5,
            failed_verification_attempts=1,
            blocked_reason="",
        )
        data = _read(self.path)
        self.assertNotIn("blockedReason", data)

    def test_blocked_reason_present_when_set(self) -> None:
        update_run_metadata_attempts(
            self.path,
            execution_attempt=2,
            max_execution_attempts=5,
            failed_verification_attempts=1,
            blocked_reason="needs review",
        )
        data = _read(self.path)
        self.assertEqual(data["blockedReason"], "needs review")


class WritePhaseStatusTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "status.json"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _write(self, **overrides):
        defaults = dict(
            phase="execution",
            status="completed",
            started_at="2026-06-10T12:00:00Z",
            finished_at="2026-06-10T12:30:00Z",
            exit_status=0,
            metadata_file="/tmp/meta.json",
            output_file="/tmp/out.txt",
            execution_attempt=1,
            max_execution_attempts=5,
        )
        defaults.update(overrides)
        write_phase_status(self.path, **defaults)

    def test_completed_case_all_fields_correct(self) -> None:
        self._write()
        data = _read(self.path)
        self.assertEqual(data["phase"], "execution")
        self.assertEqual(data["status"], "completed")
        self.assertEqual(data["startedAt"], "2026-06-10T12:00:00Z")
        self.assertEqual(data["finishedAt"], "2026-06-10T12:30:00Z")
        self.assertEqual(data["exitStatus"], 0)
        self.assertEqual(data["metadataFile"], "/tmp/meta.json")
        self.assertEqual(data["outputFile"], "/tmp/out.txt")
        self.assertEqual(data["executionAttempt"], 1)
        self.assertEqual(data["maxExecutionAttempts"], 5)

    def test_finished_at_none_when_not_set(self) -> None:
        self._write(finished_at=None)
        data = _read(self.path)
        self.assertIsNone(data["finishedAt"])

    def test_verifier_findings_file_absent_when_empty(self) -> None:
        self._write(verifier_findings_file="")
        data = _read(self.path)
        self.assertNotIn("verifierFindingsFile", data)

    def test_verifier_findings_file_present_when_set(self) -> None:
        self._write(verifier_findings_file="/tmp/findings.json")
        data = _read(self.path)
        self.assertEqual(data["verifierFindingsFile"], "/tmp/findings.json")


class WritePhaseMetadataTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "phase-meta.json"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _write(self, **overrides):
        defaults = dict(
            phase="execution",
            started_at="2026-06-10T12:00:00Z",
            finished_at="2026-06-10T12:30:00Z",
            status="completed",
            exit_status=0,
            issue=42,
            agent="claude",
            command="claude -p",
            prompt_file="/tmp/prompt.md",
            context_pack_file="/tmp/ctx.tar.gz",
            output_file="/tmp/out.txt",
            status_file="/tmp/status.json",
            run_id="run-abc123",
            run_dir="/tmp/runs/run-abc123",
            execution_attempt=1,
            max_execution_attempts=5,
        )
        defaults.update(overrides)
        write_phase_metadata(self.path, **defaults)

    def test_all_fields_present_and_correct(self) -> None:
        self._write()
        data = _read(self.path)
        self.assertEqual(data["phase"], "execution")
        self.assertEqual(data["startedAt"], "2026-06-10T12:00:00Z")
        self.assertEqual(data["finishedAt"], "2026-06-10T12:30:00Z")
        self.assertEqual(data["status"], "completed")
        self.assertEqual(data["exitStatus"], 0)
        self.assertEqual(data["targetType"], "issue")
        self.assertEqual(data["targetIssue"], 42)
        self.assertEqual(data["agent"], "claude")
        self.assertEqual(data["command"], "claude -p")
        self.assertEqual(data["promptFile"], "/tmp/prompt.md")
        self.assertEqual(data["contextPackFile"], "/tmp/ctx.tar.gz")
        self.assertEqual(data["outputFile"], "/tmp/out.txt")
        self.assertEqual(data["statusFile"], "/tmp/status.json")
        self.assertEqual(data["runId"], "run-abc123")
        self.assertEqual(data["runDir"], "/tmp/runs/run-abc123")
        self.assertEqual(data["executionAttempt"], 1)
        self.assertEqual(data["maxExecutionAttempts"], 5)

    def test_target_type_is_issue_string(self) -> None:
        self._write()
        data = _read(self.path)
        self.assertEqual(data["targetType"], "issue")

    def test_context_pack_file_none(self) -> None:
        self._write(context_pack_file=None)
        data = _read(self.path)
        self.assertIsNone(data["contextPackFile"])

    def test_finished_at_none(self) -> None:
        self._write(finished_at=None)
        data = _read(self.path)
        self.assertIsNone(data["finishedAt"])

    def test_verifier_findings_file_absent_when_empty(self) -> None:
        self._write(verifier_findings_file="")
        data = _read(self.path)
        self.assertNotIn("verifierFindingsFile", data)

    def test_verifier_findings_file_present_when_set(self) -> None:
        self._write(verifier_findings_file="/tmp/findings.json")
        data = _read(self.path)
        self.assertEqual(data["verifierFindingsFile"], "/tmp/findings.json")


if __name__ == "__main__":
    unittest.main()

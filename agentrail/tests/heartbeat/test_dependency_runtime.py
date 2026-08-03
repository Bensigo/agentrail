import json
from datetime import datetime

from agentrail.heartbeat.dependency_runtime import DependencyWatchRuntime
from agentrail.heartbeat import dependency_runtime


FILES = {
    "package.json": '{"dependencies":{"react":"^1.0.0"}}',
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      react:\n        specifier: ^1.0.0\n        version: 1.0.0\n",
}


class Executor:
    def __init__(self):
        self.executed = []

    def query(self, op, params):
        assert op == "claim_dependency_watches"
        return [{
            "id": "watch-1", "workspace_id": "ws-1", "repository_id": "repo-1",
            "repository_name": "ada/widgets", "default_branch": "main",
            "manifest_path": "package.json", "lockfile_path": "pnpm-lock.yaml",
            "selected_dependencies": ["react"], "selected_file_hashes": {},
            "cadence_seconds": 3600, "last_trigger": "manual",
        }]

    def execute(self, op, params):
        self.executed.append((op, params))


class Snapshot:
    def snapshot(self, *args):
        from agentrail.dependencies.pnpm import DependencySnapshot
        return DependencySnapshot(FILES, "sha-1")


class Registry:
    def package_metadata(self, package):
        from agentrail.dependencies.pnpm import RegistryPackage
        return RegistryPackage(("1.0.0", "1.1.0"))


class ProposalPublisher:
    def __init__(self):
        self.calls = []

    def publish(self, **kwargs):
        self.calls.append(kwargs)


def _json_default(value):
    """Encode the runtime's intentional timestamp without hiding other errors."""
    if isinstance(value, datetime):
        return value.isoformat()
    raise TypeError(f"unsupported JSON value: {type(value).__name__}")


def test_manual_watch_is_claimed_detected_and_persisted_without_queue_work():
    executor = Executor()
    publisher = ProposalPublisher()
    runtime = DependencyWatchRuntime(
        workspace_id="ws-1", executor=executor,
        snapshot_provider=Snapshot(), registry=Registry(),
        token_provider=lambda workspace_id, executor: "token",
        proposal_publisher=publisher,
    )
    result = runtime.run_once()
    assert result["claimed"] == 1
    assert result["candidates"] == 1
    assert len(executor.executed) == 1
    op, params = executor.executed[0]
    assert op == "record_dependency_watch_observation"
    assert params["status"] == "candidates"
    assert "queue" not in json.dumps(params, default=_json_default)
    assert result["proposal_errors"] == 0
    assert len(publisher.calls) == 1
    assert publisher.calls[0]["workspace_id"] == "ws-1"
    assert publisher.calls[0]["watch_id"] == "watch-1"
    assert publisher.calls[0]["candidate"].fingerprint
    assert executor.executed[0][1]["candidate_fingerprint"] == publisher.calls[0]["candidate"].fingerprint
    assert executor.executed[0][1]["candidate_fingerprint"] != executor.executed[0][1]["observation_key"]


def test_sql_observation_persists_candidate_fingerprint_separately_from_observation_key():
    sql = dependency_runtime.queue_store._SQL[dependency_runtime.RECORD_WATCH_OBSERVATION_OP]
    assert "candidate_fingerprint" in sql.split("VALUES", 1)[0]
    assert "%(candidate_fingerprint)s" in sql

from agentrail.dependencies.pnpm import DependencySnapshot, RegistryPackage
from agentrail.heartbeat.dependency_watch import (
    DependencyWatchState,
    WatchFailure,
    WatchObservation,
    WatchStore,
    WatchTrigger,
    file_hashes,
    observe_watch,
    selected_files_changed,
)


class Registry:
    def package_metadata(self, package):
        return RegistryPackage(("1.0.0", "1.1.0"))


class Targets:
    def choose_target_version(self, package, current_version, specifier, available_versions):
        return "1.1.0"


class Store:
    def __init__(self):
        self.calls = []

    def workspace_for_watch(self, watch_id):
        return "ws-1"

    def record_observation(self, **kwargs):
        self.calls.append(kwargs)
        return len(self.calls) == 1


FILES = {
    "package.json": '{"dependencies":{"react":"^1.0.0"}}',
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      react:\n        specifier: ^1.0.0\n        version: 1.0.0\n",
}


def watch(**overrides):
    values = dict(
        workspace_id="ws-1",
        repository_id="repo-1",
        selected_dependencies=("react",),
    )
    values.update(overrides)
    return DependencyWatchState(**values)


def test_push_skips_when_manifest_and_lockfile_hashes_are_unchanged():
    current = file_hashes(FILES, ("package.json", "pnpm-lock.yaml"))
    result = observe_watch(
        watch_id="watch-1",
        requested_workspace_id="ws-1",
        watch=watch(selected_file_hashes=current),
        snapshot=DependencySnapshot(FILES, "sha-2"),
        registry=Registry(),
        target_versions=Targets(),
        trigger=WatchTrigger.PUSH,
        store=Store(),
    )
    assert result.skipped is True
    assert result.failure is WatchFailure.SELECTED_FILES_UNCHANGED


def test_manual_check_runs_without_a_new_commit_and_records_one_observation():
    store = Store()
    result = observe_watch(
        watch_id="watch-1",
        requested_workspace_id="ws-1",
        watch=watch(),
        snapshot=DependencySnapshot(FILES, "sha-1"),
        registry=Registry(),
        target_versions=Targets(),
        trigger=WatchTrigger.MANUAL,
        store=store,
    )
    assert result.status == "candidates"
    assert len(result.candidates) == 1
    assert len(store.calls) == 1


def test_scheduled_check_uses_the_same_observation_path():
    store = Store()
    result = observe_watch(
        watch_id="watch-1",
        requested_workspace_id="ws-1",
        watch=watch(cadence_seconds=3600),
        snapshot=DependencySnapshot(FILES, "sha-1"),
        registry=Registry(),
        target_versions=Targets(),
        trigger=WatchTrigger.SCHEDULED,
        store=store,
    )
    assert result.status == "candidates"
    assert store.calls[0]["observation"].trigger is WatchTrigger.SCHEDULED


def test_same_candidate_fingerprint_is_stable_for_deduplication():
    store = Store()
    first = observe_watch(
        watch_id="watch-1", requested_workspace_id="ws-1", watch=watch(),
        snapshot=DependencySnapshot(FILES, "sha-1"), registry=Registry(),
        target_versions=Targets(), trigger=WatchTrigger.MANUAL, store=store,
    )
    second = observe_watch(
        watch_id="watch-1", requested_workspace_id="ws-1", watch=watch(),
        snapshot=DependencySnapshot(FILES, "sha-1"), registry=Registry(),
        target_versions=Targets(), trigger=WatchTrigger.MANUAL, store=store,
    )
    assert first.observation_key == second.observation_key
    assert store.calls[0]["observation"].candidates[0].fingerprint == store.calls[1]["observation"].candidates[0].fingerprint


def test_cross_workspace_watch_is_rejected_before_detection_or_persistence():
    store = Store()
    result = observe_watch(
        watch_id="watch-1",
        requested_workspace_id="ws-other",
        watch=watch(),
        snapshot=DependencySnapshot(FILES, "sha-1"),
        registry=Registry(),
        target_versions=Targets(),
        trigger=WatchTrigger.MANUAL,
        store=store,
    )
    assert result.failure is WatchFailure.AUTHORIZATION
    assert store.calls == []


def test_observation_failure_is_typed_and_never_persisted_as_executable_work():
    class MissingRegistry:
        def package_metadata(self, package):
            return None

    store = Store()
    result = observe_watch(
        watch_id="watch-1", requested_workspace_id="ws-1", watch=watch(),
        snapshot=DependencySnapshot(FILES, "sha-1"), registry=MissingRegistry(),
        target_versions=Targets(), trigger=WatchTrigger.MANUAL, store=store,
    )
    assert result.status == "failed"
    assert result.failure is WatchFailure.INSUFFICIENT_EVIDENCE
    assert len(store.calls) == 1
    assert "queue" not in store.calls[0]


def test_selected_file_gate_ignores_unrelated_changes():
    assert selected_files_changed({"package.json": "a", "pnpm-lock.yaml": "b"}, {"package.json": "a", "pnpm-lock.yaml": "b"}, ("package.json", "pnpm-lock.yaml")) is False

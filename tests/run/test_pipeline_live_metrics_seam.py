"""End-to-end wiring of read-grounded live metrics into the run (issue #1037).

Drives ``pipeline._record_live_context_metrics`` — the seam that runs at run
finalization — against a real temp git repo + a real persisted pack + a real
``readsCoverage`` block on run.json, and asserts the outcome the issue requires:

* AC1: a claude-engine run with a diff writes NON-ZERO read-grounded
  precision/recall to ``run.json`` under ``liveContextMetrics``, engine-tagged.
* AC2: a no-diff run writes a coverage count and NO recall value (never 0).
* AC3: a cursor run (readsCoverage status="n/a") writes an n/a read status and a
  null precision, never a measured zero.

No network: the run has no server link, so the push degrades to the local
sidecar. Bounded by tiny temp git repos; cannot hang.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

from agentrail.run import pipeline
from agentrail.shared.json import read_json, write_json


def _git(root: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)


def _init_repo(root: Path) -> None:
    _git(root, "init", "-b", "main")
    _git(root, "config", "user.email", "t@t.com")
    _git(root, "config", "user.name", "t")
    # Real repos gitignore the run-artifact tree; without this the persisted
    # pack / run.json under .agentrail/ would be mis-counted as CREATED source
    # files by the classified-change collector.
    (root / ".gitignore").write_text(".agentrail/\n")
    (root / "existing.py").write_text("x = 1\n")
    _git(root, "add", "-A")
    _git(root, "commit", "-m", "init")


def _run_dir(root: Path) -> Path:
    # Mirror the real pipeline: run artifacts live under the gitignored
    # .agentrail/ tree, so they never count as "created" source files.
    d = root / ".agentrail" / "runs" / "r"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _write_pack(root: Path, *files) -> str:
    import json

    pack = {
        "packId": "pack-seam",
        "retrievalBudget": {"maxTokens": 5000},
        "included": [{"path": p, "tokenEstimate": t} for p, t in files],
    }
    rel = ".agentrail/runs/r/context-pack.json"
    _run_dir(root)
    (root / rel).write_text(json.dumps(pack), encoding="utf-8")
    return rel


def _write_run_json(root: Path, coverage: dict) -> Path:
    meta = _run_dir(root) / "run.json"
    write_json(meta, {"readsCoverage": coverage})
    return meta


def _clear_link_env(monkeypatch) -> None:
    for var in (
        "AGENTRAIL_SERVER_BASE_URL",
        "AGENTRAIL_SERVER_API_KEY",
        "AGENTRAIL_SERVER_REPOSITORY_ID",
    ):
        monkeypatch.delenv(var, raising=False)


def test_ac1_diff_run_writes_nonzero_precision_and_recall(tmp_path, monkeypatch):
    _clear_link_env(monkeypatch)
    root = tmp_path
    _init_repo(root)
    _git(root, "checkout", "-b", "work")
    # Modify a pre-existing file that IS in the pack → recall should be 1.0.
    (root / "existing.py").write_text("x = 2\n")
    pack_file = _write_pack(root, ("existing.py", 400), ("filler.py", 100))
    # Executor read the file it edited (in the pack) → precision 400/500 = 0.8.
    meta = _write_run_json(
        root,
        {"engine": "claude", "status": "ok", "files": [{"path": "existing.py"}]},
    )

    pipeline._record_live_context_metrics(
        metadata_file=meta,
        target_dir=root,
        run_id="run-ac1",
        agent="claude",
        run_context_pack_file=pack_file,
    )

    lm = read_json(meta)["liveContextMetrics"]
    assert lm["engine"] == "claude"
    assert lm["precision"] == 0.8 and lm["precision"] != 0
    assert lm["recall"] == 1.0 and lm["recall"] != 0
    assert lm["recallStatus"] == "ok"
    # filler.py was in the pack but never read → precision waste (AC4).
    assert lm["waste"] == ["filler.py"]


def test_ac2_no_diff_run_has_coverage_but_no_recall_value(tmp_path, monkeypatch):
    _clear_link_env(monkeypatch)
    root = tmp_path
    _init_repo(root)
    _git(root, "checkout", "-b", "work")  # no changes at all
    pack_file = _write_pack(root, ("existing.py", 400))
    meta = _write_run_json(
        root,
        {"engine": "claude", "status": "ok", "files": [{"path": "existing.py"}]},
    )

    pipeline._record_live_context_metrics(
        metadata_file=meta,
        target_dir=root,
        run_id="run-ac2",
        agent="claude",
        run_context_pack_file=pack_file,
    )

    lm = read_json(meta)["liveContextMetrics"]
    assert lm["recall"] is None
    assert lm["recall"] != 0
    assert lm["recallStatus"] == "no-diff"
    assert lm["modifiedPreexistingCount"] == 0


def test_ac3_cursor_run_reports_na_never_zero(tmp_path, monkeypatch):
    _clear_link_env(monkeypatch)
    root = tmp_path
    _init_repo(root)
    _git(root, "checkout", "-b", "work")
    (root / "existing.py").write_text("x = 9\n")
    pack_file = _write_pack(root, ("existing.py", 400))
    # cursor: no transcript vehicle → status n/a.
    meta = _write_run_json(root, {"engine": "cursor", "status": "n/a", "files": []})

    pipeline._record_live_context_metrics(
        metadata_file=meta,
        target_dir=root,
        run_id="run-ac3",
        agent="cursor",
        run_context_pack_file=pack_file,
    )

    lm = read_json(meta)["liveContextMetrics"]
    assert lm["engine"] == "cursor"
    assert lm["readStatus"] == "n/a"
    assert lm["precision"] is None and lm["precision"] != 0
    # Recall is diff-derived, so a cursor run that edited a pre-existing file in
    # the pack still gets a real recall number.
    assert lm["recall"] == 1.0


def test_seam_preserves_existing_run_json_keys(tmp_path, monkeypatch):
    _clear_link_env(monkeypatch)
    root = tmp_path
    _init_repo(root)
    pack_file = _write_pack(root, ("existing.py", 400))
    meta = _run_dir(root) / "run.json"
    write_json(
        meta,
        {
            "readsCoverage": {"engine": "claude", "status": "ok", "files": []},
            "objectiveGate": {"verdict": "green"},
        },
    )

    pipeline._record_live_context_metrics(
        metadata_file=meta,
        target_dir=root,
        run_id="run-keys",
        agent="claude",
        run_context_pack_file=pack_file,
    )

    data = read_json(meta)
    # The seam is read-modify-write: it must not clobber sibling keys.
    assert data["objectiveGate"] == {"verdict": "green"}
    assert "liveContextMetrics" in data

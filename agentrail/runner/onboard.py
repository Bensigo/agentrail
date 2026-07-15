"""onboard work-kind handler — seed workspace memory from a freshly connected repo.

When a repo is first connected the backend enqueues an ``onboard`` work item (as
opposed to a normal ``issue``). The runner dispatches it here: clone the repo at
its default branch, build the context index to derive a bounded repo digest,
generate a few durable workspace-memory items via the headless Claude CLI
(fail-open — a missing binary or any error falls back to deterministic defaults),
and push them to the backend tagged ``written_by="onboarder"``.

This is BEST-EFFORT and idempotent (the enqueue side dedupes, so a re-run just
re-seeds the same handful of items). It never blocks the runner: every heavy
step (index build, LLM call, network push) is guarded so the worst outcome is a
``red`` RunResult with a reason, never an exception escaping the handler. Heavy
imports (``build_index``) are lazy so importing this module keeps runner startup
cheap.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable, List, Optional

from agentrail.run.proc import sanitized_env
from agentrail.sandbox.docker_runner import RunResult

_log = logging.getLogger(__name__)

# The workspace-memory type vocabulary the backend accepts. Any model-emitted
# type outside this set is clamped to "fact" (the neutral default).
MEMORY_TYPES = frozenset({"decision", "preference", "fact"})

# Cheap classification-tier model for the onboarding brief, overridable via env.
_DEFAULT_MODEL = os.environ.get("AGENTRAIL_ONBOARD_MODEL", "claude-haiku-4-5-20251001")

# Manifest files we sample into the digest (first ~40 lines each), in priority
# order. README first (human-authored overview), then per-ecosystem manifests.
_DIGEST_FILES = (
    "README.md",
    "package.json",
    "pyproject.toml",
    "go.mod",
    "Cargo.toml",
    "Makefile",
)

_DIGEST_HEAD_LINES = 40
_DIGEST_FILE_MAX_BYTES = 200 * 1024
_DIGEST_MAX_CHARS = 6000
_MAX_ITEMS = 8
_CALL_TIMEOUT_SECONDS = 60
_CLONE_TIMEOUT_SECONDS = 300
_PUSH_TIMEOUT_SECONDS = 10


# ---------------------------------------------------------------------------
# Clone
# ---------------------------------------------------------------------------

def _clone(repo_url: str, ref: str, dest: str, *, runner=subprocess, timeout: int = _CLONE_TIMEOUT_SECONDS) -> None:
    """Shallow-clone ``repo_url`` at ``ref`` into ``dest``.

    ``runner`` is injected (default :mod:`subprocess`) so tests never touch the
    network. Raises :class:`RuntimeError` (carrying the stderr tail) on a
    non-zero exit so the caller can classify it as a clone failure.
    """
    proc = runner.run(
        ["git", "clone", "--depth", "1", "--branch", ref, repo_url, dest],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if getattr(proc, "returncode", 1) != 0:
        stderr = (getattr(proc, "stderr", "") or "")[-500:].strip()
        raise RuntimeError(f"git clone failed: {stderr or '(no output)'}")


# ---------------------------------------------------------------------------
# Digest
# ---------------------------------------------------------------------------

def _repo_digest(repo_dir: Path, index_summary: Optional[dict]) -> str:
    """Bounded plain-text digest of a cloned repo, for the onboarding brief.

    Combines the top-level dir/file listing, a one-line index-stats summary (when
    ``index_summary`` is present), and the first ~40 lines of whichever common
    manifest files exist. Decode errors are tolerated, oversized files skipped,
    and the whole thing is capped to ~6000 chars so the brief stays a cheap call.
    """
    parts: List[str] = []

    try:
        entries = sorted(e for e in os.listdir(repo_dir) if e != ".git")
    except OSError:
        entries = []
    parts.append("Top-level entries: " + (", ".join(entries) if entries else "(none)"))

    if index_summary:
        parts.append(
            "Index stats: "
            f"{index_summary.get('indexed', 0)} files indexed, "
            f"{index_summary.get('graphNodes', 0)} graph nodes, "
            f"commit {index_summary.get('commitSha', '') or 'unknown'}."
        )

    for name in _DIGEST_FILES:
        fpath = repo_dir / name
        if not fpath.is_file():
            continue
        try:
            if fpath.stat().st_size > _DIGEST_FILE_MAX_BYTES:
                continue
            text = fpath.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        head = "\n".join(text.splitlines()[:_DIGEST_HEAD_LINES])
        parts.append(f"--- {name} ---\n{head}")

    return "\n\n".join(parts)[:_DIGEST_MAX_CHARS]


def _detect_command_hints(digest: str) -> List[str]:
    """Best-effort guess at build/test commands from manifests seen in ``digest``."""
    low = digest.lower()
    hints: List[str] = []
    if "package.json" in low:
        hints.append("npm install / npm test / npm run build")
    if "pyproject.toml" in low or "setup.py" in low:
        hints.append("pytest")
    if "makefile" in low:
        hints.append("make")
    if "go.mod" in low:
        hints.append("go build ./... / go test ./...")
    if "cargo.toml" in low:
        hints.append("cargo build / cargo test")
    return hints


# ---------------------------------------------------------------------------
# Item generation
# ---------------------------------------------------------------------------

def _default_items(digest: str, index_summary: Optional[dict]) -> List[dict]:
    """Deterministic fallback items when the LLM path is unavailable.

    Always returns at least two items: a ``decision`` summarizing the repo's
    structure/stack and a ``preference`` carrying detected build/test hints (or a
    generic "enrich later" note). Every item is tagged ``["onboard"]``.
    """
    stats = ""
    if index_summary:
        stats = (
            f" Index built: {index_summary.get('indexed', 0)} files, "
            f"{index_summary.get('graphNodes', 0)} graph nodes, "
            f"commit {index_summary.get('commitSha', '') or 'unknown'}."
        )
    head = " ".join(digest.split())[:400]
    decision = {
        "content": (
            "Repository onboarded. Structure and stack, derived from the top-level "
            f"layout and manifests: {head}.{stats}"
        ),
        "type": "decision",
        "tags": ["onboard"],
    }

    hints = _detect_command_hints(digest)
    if hints:
        pref_content = "Detected project commands: " + "; ".join(hints) + "."
    else:
        pref_content = "Context index built; enrich build/test command hints later."
    preference = {
        "content": pref_content,
        "type": "preference",
        "tags": ["onboard"],
    }
    return [decision, preference]


def _build_onboard_prompt(digest: str) -> str:
    """Compact prompt instructing the model to emit onboarding memory items (pure)."""
    return "\n".join(
        [
            "You are onboarding a software repository into a durable workspace memory.",
            "Study the repository digest below and produce a small set of durable,",
            "high-signal memory items a future engineer or coding agent would want.",
            "",
            "Cover, where the digest supports it:",
            "- coding conventions and style the repo follows",
            "- an architecture / module map (what the main directories and modules do)",
            "- how to build, test, lint, and run the project (exact commands)",
            "- a short domain glossary of project-specific terms",
            "",
            "Repository digest:",
            digest,
            "",
            'Reply with ONLY a JSON array of objects, each',
            '{"content": <str>, "type": <str>, "tags": [<str>...]} where "type" is',
            'exactly "decision" or "preference". At most 8 items. No prose, no',
            "markdown fences — only the JSON array.",
        ]
    )


def _call_model(model: str, prompt: str) -> str:
    """The ONE network seam: one headless ``claude -p`` call (monkeypatch in tests).

    Mirrors ``agentrail/context/llm_rerank.py:_call_model`` — rides the
    authenticated Claude Code CLI harness (no ``anthropic`` SDK, no
    ``ANTHROPIC_API_KEY`` dependency), with the agent-session env stripped via
    :func:`sanitized_env`. ``--output-format json`` makes stdout a result
    envelope whose ``result`` is the assistant text. A non-zero exit or a missing
    ``result`` raises so the caller falls open to deterministic defaults.
    """
    argv = [
        "claude",
        "-p",
        "--dangerously-skip-permissions",
        "--output-format",
        "json",
        "--model",
        model,
    ]
    completed = subprocess.run(
        argv,
        input=prompt,
        text=True,
        capture_output=True,
        timeout=_CALL_TIMEOUT_SECONDS,
        env=sanitized_env(),
    )
    if completed.returncode != 0:
        raise RuntimeError(f"headless onboard call exited {completed.returncode}")
    envelope = json.loads(completed.stdout or "")
    result = envelope.get("result") if isinstance(envelope, dict) else None
    if not isinstance(result, str):
        raise ValueError("headless response missing 'result' text")
    return result


def _postprocess_items(raw_items: list) -> List[dict]:
    """Coerce raw model items into the pinned shape (pure, defensive).

    Drops non-dict / empty-content entries, clamps ``type`` to
    :data:`MEMORY_TYPES` (invalid/missing → "fact"), defaults ``tags`` to
    ``["onboard"]`` when not a list, and caps the result to :data:`_MAX_ITEMS`.
    """
    out: List[dict] = []
    for entry in raw_items:
        if not isinstance(entry, dict):
            continue
        content = entry.get("content")
        if not isinstance(content, str):
            content = "" if content is None else str(content)
        content = content.strip()
        if not content:
            continue
        item_type = entry.get("type")
        if item_type not in MEMORY_TYPES:
            item_type = "fact"
        tags = entry.get("tags")
        if not isinstance(tags, list):
            tags = ["onboard"]
        out.append({"content": content, "type": item_type, "tags": tags})
        if len(out) >= _MAX_ITEMS:
            break
    return out


def generate_onboard_items(
    digest: str,
    *,
    model: Optional[str] = None,
    call_model: Optional[Callable[[str, str], str]] = None,
) -> List[dict]:
    """Generate durable onboarding memory items from ``digest`` (fail-open).

    Prompts the model (default seam :func:`_call_model`) for a JSON array of
    ``{content, type, tags}`` items covering conventions, an architecture map,
    build/test commands, and a glossary. Gated on ``claude`` being on PATH unless
    ``call_model`` is injected. The entire call+parse is wrapped so ANY failure —
    missing binary, non-zero exit, unparseable JSON — falls back to
    :func:`_default_items`. Output is post-processed and capped to 8 items.
    """
    model = model or _DEFAULT_MODEL
    if call_model is None:
        if shutil.which("claude") is None:
            return _default_items(digest, None)
        call = _call_model
    else:
        call = call_model

    try:
        prompt = _build_onboard_prompt(digest)
        raw = call(model, prompt)
        parsed = json.loads(raw)
        if not isinstance(parsed, list):
            raise ValueError("model did not return a JSON array")
        items = _postprocess_items(parsed)
    except Exception as exc:  # noqa: BLE001 - any failure falls open to defaults
        _log.warning("onboard: LLM item generation failed (%s); using defaults", exc)
        return _default_items(digest, None)

    if not items:
        return _default_items(digest, None)
    return items


# ---------------------------------------------------------------------------
# Push
# ---------------------------------------------------------------------------

def push_onboard_items(
    base_url: str,
    api_key: str,
    repository_id: str,
    run_id: str,
    items: List[dict],
    *,
    opener: Optional[Callable] = None,
) -> tuple[bool, str]:
    """POST onboarding memory items to the backend ingest route.

    Sends the pinned contract to ``{base_url}/api/v1/ingest/memory-items`` with a
    Bearer header, ``written_by="onboarder"``, ``source="onboard"``. Returns
    ``(status == 202, short_detail)``. The ``opener`` seam defaults to
    :func:`urllib.request.urlopen`; HTTP/URL errors are caught and returned as
    ``(False, detail)`` so a push failure never raises.
    """
    url = base_url.rstrip("/") + "/api/v1/ingest/memory-items"
    payload = {
        "run_id": str(run_id),
        "repository_id": str(repository_id),
        "written_by": "onboarder",
        "source": "onboard",
        "items": items,
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    send = opener or urllib.request.urlopen
    try:
        resp = send(req, timeout=_PUSH_TIMEOUT_SECONDS)
    except urllib.error.HTTPError as exc:
        return False, f"HTTP {exc.code}"
    except urllib.error.URLError as exc:
        return False, f"URLError: {exc.reason}"
    except Exception as exc:  # noqa: BLE001 - push must never raise into the handler
        return False, f"error: {exc}"

    try:
        status = int(getattr(resp, "status", None) or getattr(resp, "code", 0) or 0)
    finally:
        close = getattr(resp, "close", None)
        if callable(close):
            try:
                close()
            except Exception:  # noqa: BLE001
                pass
    return status == 202, f"HTTP {status}"


# ---------------------------------------------------------------------------
# Handler
# ---------------------------------------------------------------------------

def run_onboard(
    item,
    *,
    base_url: str,
    api_key: str,
    clone_fn: Callable[..., None] = _clone,
    index_fn: Optional[Callable[[Path], dict]] = None,
    brief_fn: Callable[..., List[dict]] = generate_onboard_items,
    push_fn: Callable[..., tuple] = push_onboard_items,
    work_dir_factory: Optional[Callable[[], str]] = None,
) -> RunResult:
    """Onboard a freshly connected repo into workspace memory (best-effort).

    Clones the repo into a fresh temp dir, builds the context index for a digest,
    generates durable memory items, and pushes them. All heavy steps are seams
    (injectable for hermetic tests) and best-effort: a missing ``repository_id``
    is ``red`` (documents the PR3 enqueue dependency), a clone failure is
    ``error``, and a failed push is ``red`` — nothing raises out of here. The temp
    dir is always torn down.
    """
    if not item.repository_id:
        return RunResult(
            status="red",
            gate_reason="onboard requires repository_id",
            branch=item.ref,
        )

    work_dir = (work_dir_factory or tempfile.mkdtemp)()
    repo_dir = Path(work_dir) / "repo"
    try:
        try:
            clone_fn(item.repo_url, item.ref or "main", str(repo_dir))
        except Exception as exc:  # noqa: BLE001 - clone failure is a run error
            return RunResult(
                status="error",
                gate_reason=f"clone failed: {exc}",
                branch=item.ref,
            )

        # Build the context index for a repo digest (best-effort — a repo whose
        # summary mode isn't "disabled" raises, and we simply skip the stats).
        index_summary: Optional[dict] = None
        try:
            if index_fn is not None:
                index_summary = index_fn(repo_dir)
            else:
                from agentrail.context.index import build_index  # lazy: heavy import

                index_summary = build_index(repo_dir)
        except Exception as exc:  # noqa: BLE001 - index is best-effort
            _log.warning("onboard: index build failed for %s: %s", item.repo_url, exc)

        digest = _repo_digest(repo_dir, index_summary)
        items = brief_fn(digest, model=_DEFAULT_MODEL)
        if not items:
            return RunResult(
                status="red",
                gate_reason="no memory items generated",
                branch=item.ref,
            )

        ok, detail = push_fn(base_url, api_key, item.repository_id, item.id, items)
        if not ok:
            return RunResult(
                status="red",
                gate_reason=f"memory push failed: {detail}",
                branch=item.ref,
            )

        return RunResult(
            status="green",
            gate_reason=f"onboarded {item.repo_url}: {len(items)} memory items",
            branch=item.ref,
            logs_tail=detail[:2000],
        )
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)

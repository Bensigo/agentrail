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
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, List, Optional

from agentrail.run.proc import sanitized_env
from agentrail.sandbox.clone_auth import authenticated_clone_url, redact_token
from agentrail.sandbox.docker_runner import RunResult

_log = logging.getLogger(__name__)

# The workspace-memory type vocabulary the backend accepts. Any model-emitted
# type outside this set is clamped to "fact" (the neutral default).
MEMORY_TYPES = frozenset({"decision", "preference", "fact"})

# Fixed skeleton the onboarder emits — a coherent, retrievable set of categories
# rather than a loose pile. Each maps to one memory item with a stable
# ``onboard:<category>`` tag and a fixed memory type (all in MEMORY_TYPES).
ONBOARD_CATEGORIES = ("conventions", "architecture", "commands", "glossary")
_CATEGORY_TYPE = {
    "architecture": "decision",
    "conventions": "preference",
    "commands": "preference",
    "glossary": "fact",
}

# If the repo was onboarded within this many days, reuse the existing notes
# instead of re-cloning/indexing/LLM-ing. Overridable via env; bad values → 30.
try:
    _FRESH_DAYS = int(os.environ.get("AGENTRAIL_ONBOARD_FRESH_DAYS", "30"))
    if _FRESH_DAYS <= 0:
        _FRESH_DAYS = 30
except (TypeError, ValueError):
    _FRESH_DAYS = 30

# Cheap classification-tier model for the onboarding brief, overridable via env.
_DEFAULT_MODEL = os.environ.get("AGENTRAIL_ONBOARD_MODEL", "claude-haiku-4-5-20251001")

# Files we sample into the digest, in priority order. Human-authored context
# docs (CLAUDE.md / AGENTS.md / CONTRIBUTING.md) come FIRST — they are far
# higher-signal than an LLM's guesses — then the README and per-ecosystem
# manifests. The whole digest is char-capped downstream so this stays bounded.
_DIGEST_FILES = (
    "CLAUDE.md",
    "AGENTS.md",
    "CONTRIBUTING.md",
    "README.md",
    "package.json",
    "pyproject.toml",
    "go.mod",
    "Cargo.toml",
    "Makefile",
)

# Agent-context docs get a larger head-line budget so more of them lands in the
# digest; the overall _DIGEST_MAX_CHARS cap still bounds the prompt.
_AGENT_DOC_FILES = frozenset({"CLAUDE.md", "AGENTS.md"})
_DIGEST_HEAD_LINES = 40
_DIGEST_AGENT_DOC_HEAD_LINES = 120
_DIGEST_FILE_MAX_BYTES = 200 * 1024
_DIGEST_MAX_CHARS = 6000
_MAX_ITEMS = 8
_CALL_TIMEOUT_SECONDS = 60
_CLONE_TIMEOUT_SECONDS = 300
_PUSH_TIMEOUT_SECONDS = 10
_FRESHNESS_TIMEOUT_SECONDS = 10


# ---------------------------------------------------------------------------
# Clone
# ---------------------------------------------------------------------------

def _clone(
    repo_url: str,
    ref: str,
    dest: str,
    *,
    token: str = "",
    runner=subprocess,
    timeout: int = _CLONE_TIMEOUT_SECONDS,
) -> None:
    """Shallow-clone ``repo_url`` at ``ref`` into ``dest``.

    ``token`` (a workspace's connected GitHub OAuth token, or a locally
    configured PAT) is embedded as HTTP Basic auth in the clone URL when
    present, via :func:`agentrail.sandbox.clone_auth.authenticated_clone_url`
    — the SAME mechanism ``native_runner``'s host-sandbox clone uses. Before
    #1268 this handler never authenticated at all, so any private-repo
    onboard burned all its retries on an identical clone failure, every time,
    on every runner.

    ``runner`` is injected (default :mod:`subprocess`) so tests never touch the
    network. Raises :class:`RuntimeError` on a non-zero exit or on a
    subprocess-level error (e.g. a timeout) — carrying the stderr tail /
    exception text, always with ``token`` redacted first via
    :func:`agentrail.sandbox.clone_auth.redact_token`. Redaction happens here
    regardless of what git itself printed: git's own diagnostics don't
    reliably omit an embedded credential across every version/failure mode,
    and — the concrete risk — ``subprocess.CalledProcessError`` /
    ``TimeoutExpired.__str__()`` unconditionally embed the raw argv they were
    constructed with (i.e. the credentialed clone URL) regardless of what the
    child process printed, so an unredacted exception message is a real
    token-leak path into ``gate_reason``.
    """
    clone_url = authenticated_clone_url(repo_url, token)
    try:
        proc = runner.run(
            ["git", "clone", "--depth", "1", "--branch", ref, clone_url, dest],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except (subprocess.SubprocessError, OSError) as exc:
        raise RuntimeError(redact_token(f"git clone failed: {exc}", token)) from None
    if getattr(proc, "returncode", 1) != 0:
        stderr = redact_token((getattr(proc, "stderr", "") or "")[-500:].strip(), token)
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
        head_lines = (
            _DIGEST_AGENT_DOC_HEAD_LINES if name in _AGENT_DOC_FILES else _DIGEST_HEAD_LINES
        )
        head = "\n".join(text.splitlines()[:head_lines])
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

def _category_item(category: str, content: str) -> dict:
    """One skeleton memory item for ``category`` (mapped type + stable tags)."""
    return {
        "content": content,
        "type": _CATEGORY_TYPE[category],
        "tags": ["onboard", f"onboard:{category}"],
    }


def _default_items(digest: str, index_summary: Optional[dict]) -> List[dict]:
    """Deterministic fallback items when the LLM path is unavailable.

    Emits the SAME category skeleton as the LLM path where derivable: an
    ``architecture`` (decision) item from the digest/index summary, a
    ``commands`` (preference) item from :func:`_detect_command_hints`, and — only
    when the digest actually ships the source docs — a best-effort ``conventions``
    (preference) item. Glossary is omitted (nothing reliable to derive offline).
    Always returns at least the two core items; each is tagged
    ``["onboard", "onboard:<category>"]``.
    """
    items: List[dict] = []

    stats = ""
    if index_summary:
        stats = (
            f" Index built: {index_summary.get('indexed', 0)} files, "
            f"{index_summary.get('graphNodes', 0)} graph nodes, "
            f"commit {index_summary.get('commitSha', '') or 'unknown'}."
        )
    head = " ".join(digest.split())[:400]
    items.append(
        _category_item(
            "architecture",
            "Repository onboarded. Structure and stack, derived from the top-level "
            f"layout and manifests: {head}.{stats}",
        )
    )

    hints = _detect_command_hints(digest)
    if hints:
        commands_content = "Detected project commands: " + "; ".join(hints) + "."
    else:
        commands_content = "Context index built; enrich build/test command hints later."
    items.append(_category_item("commands", commands_content))

    # Best-effort conventions item — only when the repo actually ships the
    # human-authored contributor docs (otherwise omit rather than fabricate).
    low = digest.lower()
    if "claude.md" in low or "agents.md" in low or "contributing.md" in low:
        items.append(
            _category_item(
                "conventions",
                "Repository ships human-authored contributor docs "
                "(CLAUDE.md / AGENTS.md / CONTRIBUTING.md); follow their stated "
                "conventions and workflow when editing.",
            )
        )

    return items


def _build_onboard_prompt(digest: str) -> str:
    """Compact prompt: emit a fixed four-category JSON object (pure)."""
    return "\n".join(
        [
            "You are onboarding a software repository into a durable workspace memory.",
            "Study the repository digest below and summarize it into exactly four",
            "categories a future engineer or coding agent would want:",
            "- conventions: coding conventions and style the repo follows",
            "- architecture: the module/architecture map (what the main directories",
            "  and modules do)",
            "- commands: how to build, test, lint, and run the project (exact commands)",
            "- glossary: a short domain glossary of project-specific terms",
            "",
            "Repository digest:",
            digest,
            "",
            "Reply with ONLY a JSON OBJECT whose keys are EXACTLY these four:",
            '"conventions", "architecture", "commands", "glossary". Each value is a',
            "concise plain-text string (a few sentences) grounded in the digest. Use",
            'an empty string "" for a category the digest gives you nothing for. No',
            "other keys, no prose, no markdown fences — only the JSON object.",
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

    Prompts the model (default seam :func:`_call_model`) for a JSON OBJECT keyed
    by the four :data:`ONBOARD_CATEGORIES`. For each category present with
    non-empty string content one memory item is emitted, typed via
    :data:`_CATEGORY_TYPE` and tagged ``["onboard", "onboard:<category>"]``;
    empty/missing categories are skipped. Gated on ``claude`` being on PATH unless
    ``call_model`` is injected. The entire call+parse is wrapped so ANY failure —
    missing binary, non-zero exit, unparseable JSON, wrong shape — falls back to
    :func:`_default_items`. Output is post-processed (type/content/tags clamp) and
    capped to :data:`_MAX_ITEMS`.
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
        if not isinstance(parsed, dict):
            raise ValueError("model did not return a JSON object")
        raw_items: List[dict] = []
        for category in ONBOARD_CATEGORIES:
            value = parsed.get(category)
            if not isinstance(value, str):
                continue
            content = value.strip()
            if not content:
                continue
            raw_items.append(_category_item(category, content))
        items = _postprocess_items(raw_items)
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
        "replace_by_writer": True,
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
# Freshness reuse gate
# ---------------------------------------------------------------------------

def _utcnow() -> datetime:
    """Aware UTC now (app code, so the stdlib clock is fine)."""
    return datetime.now(timezone.utc)


def _repo_full_name(item) -> str:
    """Best-effort ``owner/name`` for ``item`` (small, defensive).

    Prefers ``external_id`` when it carries the ``onboard:owner/name`` form;
    otherwise falls back to parsing ``repo_url`` (strip the GitHub host and a
    trailing ``.git``). Returns ``""`` if nothing usable is present.
    """
    ext = (getattr(item, "external_id", "") or "").strip()
    if ext.startswith("onboard:"):
        name = ext[len("onboard:"):].strip().strip("/")
        if name:
            return name

    url = (getattr(item, "repo_url", "") or "").strip()
    prefix = "https://github.com/"
    if url.startswith(prefix):
        url = url[len(prefix):]
    if url.endswith(".git"):
        url = url[: -len(".git")]
    return url.strip("/")


def check_onboard_freshness(
    base_url: str,
    api_key: str,
    repo_full_name: str,
    *,
    opener: Optional[Callable] = None,
) -> Optional[datetime]:
    """When was ``repo_full_name`` last onboarded? (aware datetime or None).

    GETs ``{base_url}/api/v1/runner/onboard-status?repo=<url-encoded>`` with a
    Bearer header and parses ``{ onboardedAt: ISO8601|null, count }``. FAIL-OPEN:
    any error — no repo, network failure, non-200, bad/empty JSON, null
    ``onboardedAt``, unparseable timestamp — returns ``None`` so onboarding
    proceeds (we never wrongly SKIP). The returned datetime is always tz-aware
    (naive timestamps are assumed UTC).
    """
    if not repo_full_name:
        return None

    url = (
        base_url.rstrip("/")
        + "/api/v1/runner/onboard-status?repo="
        + urllib.parse.quote(repo_full_name, safe="")
    )
    req = urllib.request.Request(
        url,
        method="GET",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
        },
    )
    send = opener or urllib.request.urlopen
    try:
        resp = send(req, timeout=_FRESHNESS_TIMEOUT_SECONDS)
    except Exception:  # noqa: BLE001 - fail open: proceed with onboarding
        return None

    try:
        status = int(getattr(resp, "status", None) or getattr(resp, "code", 0) or 0)
        read = getattr(resp, "read", None)
        raw = read() if callable(read) else b""
    except Exception:  # noqa: BLE001
        return None
    finally:
        close = getattr(resp, "close", None)
        if callable(close):
            try:
                close()
            except Exception:  # noqa: BLE001
                pass

    if status != 200:
        return None
    try:
        if isinstance(raw, (bytes, bytearray)):
            raw = raw.decode("utf-8")
        data = json.loads(raw or "")
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(data, dict):
        return None

    onboarded_at = data.get("onboardedAt")
    if not isinstance(onboarded_at, str) or not onboarded_at.strip():
        return None
    iso = onboarded_at.strip()
    if iso.endswith("Z"):
        iso = iso[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(iso)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


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
    freshness_fn: Callable[..., Optional[datetime]] = check_onboard_freshness,
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

    # Freshness reuse gate: if this repo was onboarded recently, reuse those
    # notes instead of re-cloning/indexing/LLM-ing. Fail-open — a None (any
    # error or no prior onboarding) means proceed, so we never wrongly skip.
    onboarded_at = freshness_fn(base_url, api_key, _repo_full_name(item))
    if onboarded_at is not None:
        age = _utcnow() - onboarded_at
        if age < timedelta(days=_FRESH_DAYS):
            return RunResult(
                status="green",
                gate_reason=f"reused existing onboarding ({age.days}d old)",
                branch=item.ref,
            )

    work_dir = (work_dir_factory or tempfile.mkdtemp)()
    repo_dir = Path(work_dir) / "repo"
    try:
        try:
            # item already carries github_token (WorkItem.from_dict parses it
            # unconditionally, same as issue-kind items) — threaded straight
            # through rather than via env, since clone_fn is plain Python
            # here, not a shelled-out contract (#1268).
            #
            # DELIBERATE DIVERGENCE from the issue path's GIT_TOKEN semantics
            # (agentrail/cli/commands/runner.py, _make_execute): the issue
            # path falls back to a locally configured GIT_TOKEN env var when
            # the claim carries no token. Onboard uses ONLY the claim's
            # item.github_token, with NO process-env fallback — on the hosted
            # fleet, one shared process serves MANY workspaces, so reading
            # process-wide os.environ["GIT_TOKEN"] here would risk cloning
            # workspace A's repo with workspace B's (or the operator's own)
            # credentials: cross-workspace token bleed. Plain consequence: a
            # self-hosted operator with a local PAT but no linked GitHub
            # owner gets an UNAUTHENTICATED onboard clone (private-repo
            # onboard fails for them until they link a GitHub owner), which
            # is the accepted trade — correctness of tenant isolation over
            # that convenience.
            clone_fn(item.repo_url, item.ref or "main", str(repo_dir), token=item.github_token)
        except Exception as exc:  # noqa: BLE001 - clone failure is a run error
            # Defense in depth: _clone (the default clone_fn) already redacts
            # the token from anything it raises, but clone_fn is an
            # injectable seam — a caller-supplied one might not, so redact
            # again here with the one token this handler actually knows.
            return RunResult(
                status="error",
                gate_reason=redact_token(f"clone failed: {exc}", item.github_token),
                branch=item.ref,
            )

        # Never trust a committed/stale context index — force a clean rebuild.
        shutil.rmtree(repo_dir / ".agentrail" / "context" / "index", ignore_errors=True)

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

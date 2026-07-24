"""Push compiled Repo Wiki pages to the linked AgentRail server (Repo Wiki
spec §4.4 contract 1 — docs/superpowers/specs/2026-07-23-repo-wiki-compiled-repo-knowledge-design.md,
delivery plan §7 row 4).

Reuses the ``.agentrail/server.json`` + Bearer + ingest-endpoint rail
(:func:`agentrail.context.snapshot_push.load_link`) exactly like
:mod:`agentrail.context.snapshot_push` and :mod:`agentrail.context.memory_fetch`
already do. The server is the wiki's durable home — clones are ephemeral
(``tempfile.mkdtemp`` + ``rmtree`` on every path in this codebase: onboard.py,
sandbox/native_runner.py, sandbox/docker_runner.py) — so a push failure must
never block a local compile: every failure here is non-fatal, mirroring
:func:`agentrail.context.snapshot_push.push_index_snapshot`'s contract
exactly (bounded timeout, catch-all ``except Exception``, return ``bool``,
never raise).

WHY ``repo_full_name`` is a REQUIRED caller-supplied argument rather than
something this module derives itself: ``server.json`` carries only
``repository_id`` (a UUID — see :func:`load_link`'s return shape), and the
wiki wire contract (``POST /api/v1/ingest/wiki-pages``) is scoped by repo
FULL NAME, not id — deliberately, matching the two read contracts
(``GET /api/v1/context/wiki-pages?repo=``, ``GET /api/v1/runner/repo-wiki?repo=``)
that hydration and Jace also use, so the server side never needs a
``repository_id`` round trip to resolve identity (house "names over ids"
convention). The caller — the compiler's onboard/index wiring (PR 2, not yet
built; out of this PR's scope, see the delivery-plan note in this repo's PR
body) — already knows the repo's full name from its own invocation context,
so this module does not duplicate that resolution (e.g. via git-remote
parsing, which would also cross the context/ -> afk/ layer boundary
:func:`agentrail.context.snapshot_push.load_link`'s own docstring already
flags as something to avoid).

SOURCE CUSTODY (spec open question 1): controlled by
:attr:`agentrail.context.config.WikiConfig.upload` (default ``True``). When
``False``, this module skips the network entirely — the caller does not need
its own flag check.

CHUNKING (module-grain pages, added 2026-07-24): a compile's page count can
exceed the server's per-request cap once a large unit splits into module
pages (see :mod:`agentrail.context.wiki`'s module-split section). The caller
(:func:`agentrail.runner.onboard._push_wiki`) still passes the WHOLE page
list in one call — :func:`push_wiki_pages` itself splits it into sequential
batches of at most :data:`WIKI_PUSH_BATCH_SIZE`, safe because the ingest
route's write is a per-``(repository_id, slug)`` upsert, never a whole-batch
transaction.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

from agentrail.context.config import read_context_config
from agentrail.context.snapshot_push import load_link

# Short, same as snapshot_push/memory_fetch: a slow server must never stall a
# compile.
WIKI_PUSH_TIMEOUT_SECONDS = 5

# The server's own cap (apps/console/app/api/v1/ingest/wiki-pages/route.ts's
# MAX_PAGES_PER_PUSH) -- module-grain pages (this PR) can push a compile's
# page count well past a single request's worth. Chunking is safe because
# the ingest route's write is per-(repository_id, slug) upsert, never a
# whole-batch transaction: each POST lands or doesn't independently of the
# others, so splitting one compile across several sequential requests changes
# nothing about correctness, only how many round trips it takes.
WIKI_PUSH_BATCH_SIZE = 40


def _batches(pages: List[Dict[str, Any]], size: int) -> List[List[Dict[str, Any]]]:
    """Split PAGES into chunks of at most SIZE. An empty ``pages`` still
    yields exactly one (empty) batch -- preserves the pre-chunking contract
    of sending a single request when there is only a ``compile_event`` and
    no pages (see push_wiki_pages's "nothing to send" guard, which already
    short-circuits the true no-op case of empty pages AND no compile_event)."""
    if not pages:
        return [[]]
    return [pages[i:i + size] for i in range(0, len(pages), size)]


def _post_batch(base_url: str, api_key: str, repo_full_name: str, batch: List[Dict[str, Any]], compile_event: Optional[Dict[str, Any]]) -> bool:
    """POST one batch. Returns True only on HTTP 200; NEVER raises -- a
    single batch's failure (network, auth, non-200, malformed response) must
    not prevent :func:`push_wiki_pages` from attempting the remaining
    batches (per-batch non-fatal accounting)."""
    payload: Dict[str, Any] = {"repoFullName": repo_full_name, "pages": batch}
    if compile_event is not None:
        payload["compileEvent"] = compile_event
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{base_url}/api/v1/ingest/wiki-pages",
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=WIKI_PUSH_TIMEOUT_SECONDS) as resp:
            return int(resp.status) == 200
    except Exception:  # noqa: BLE001 — one batch's failure must not abort the others
        return False


def push_wiki_pages(
    target: Path,
    repo_full_name: str,
    pages: List[Dict[str, Any]],
    compile_event: Optional[Dict[str, Any]] = None,
) -> bool:
    """POST ``pages`` (+ an optional ``compile_event``) to the linked server,
    chunked into sequential batches of at most :data:`WIKI_PUSH_BATCH_SIZE`
    pages (the server's own per-request cap).

    ``pages`` is the wire-shaped PAGE list (camelCase, minus ``stale`` — the
    server owns freshness, not the pusher); ``compile_event`` is the optional
    ``{commitSha, pagesWritten, pagesReused, costUsd, model, durationMs}``
    telemetry object, attached to exactly ONE request (the LAST batch) — it
    describes the compile as a whole, not any one page batch, so it is never
    duplicated across requests. Both are passed through as-is (this module
    does no shaping beyond wrapping them in the request envelope) — the
    caller is responsible for building well-formed page dicts.

    Every batch is attempted regardless of an earlier batch's outcome
    (best-effort, per-batch non-fatal — see :func:`_post_batch`). Returns
    True only when EVERY batch returned HTTP 200. Returns False, and NEVER
    raises, when: the repo is unlinked, the workspace's wiki-upload custody
    switch is off, there is nothing to send (no pages AND no compile_event),
    or any batch's request fails for any reason (network, auth, non-200
    status, malformed response) — a page list at or under the cap behaves
    identically to before chunking existed (exactly one request).
    """
    if not pages and compile_event is None:
        return False
    try:
        config = read_context_config(target)
        if not config.wiki.upload:
            return False

        link = load_link(Path(target))
        if link is None:
            return False

        batches = _batches(pages, WIKI_PUSH_BATCH_SIZE)
        last_index = len(batches) - 1
        all_ok = True
        for index, batch in enumerate(batches):
            batch_event = compile_event if index == last_index else None
            ok = _post_batch(link["base_url"], link["api_key"], repo_full_name, batch, batch_event)
            all_ok = all_ok and ok
        return all_ok
    except Exception:  # noqa: BLE001 — non-fatal by design, like snapshot_push
        return False

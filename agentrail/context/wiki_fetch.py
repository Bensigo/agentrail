"""Hydrate the linked server's compiled Repo Wiki into the local cache (Repo
Wiki spec §4.2 "hydrate .agentrail/context/wiki/ from server wiki_pages" —
docs/superpowers/specs/2026-07-23-repo-wiki-compiled-repo-knowledge-design.md,
delivery plan §7 row 4).

Mirrors :mod:`agentrail.context.memory_fetch` exactly: the link (base URL +
bearer key) comes from :func:`agentrail.context.snapshot_push.load_link`, the
timeout is short, EVERY failure is non-fatal (never raises), and a local
cache younger than :data:`WIKI_SNAPSHOT_TTL_SECONDS` skips the network round
trip so a normal compile hits the server about once rather than once per
pack.

WHY HYDRATION IS LOAD-BEARING (spec §4.2): without it, every fresh fleet
clone finds an empty wiki dir, hash-diffs every page as changed, and
recompiles the whole wiki per run — LLM cost and latency exactly where the
design promises amortization. The server row, not the checkout, is the
artifact; the local dir this module writes is a working copy that dies with
the clone, by design.

WRITES (under ``.agentrail/context/wiki/`` — already excluded from the index
file walk by ``config.py``'s ``DEFAULT_EXCLUDE_GLOBS``, the same generated-cache
exclusion ``.agentrail/context/memory/`` relies on):

* ``manifest.json`` — ``{repo, fetchedAt, pages: [{slug, inputsHash, stale}]}``
  — the compiler's (PR 2, not yet wired) hash-diff input: it never needs to
  re-fetch full ``bodyMd`` to know whether a page's ``inputsHash`` still
  matches.
* one ``.md`` file per page — YAML frontmatter mirroring spec §4.1's shape
  (slug/title/kind/commitSha/inputsHash/generatedAt/model/citations) plus
  ``bodyMd`` — named by a deterministic slug -> filename mapping (see
  :func:`wiki_page_filename`).

Any ``.md`` file left over from a previous fetch that is no longer present in
the current server response is pruned — this directory is exclusively
populated by this function (nothing else ever writes into a generated-cache
namespace), so it is safe, and correct, to make the local snapshot an
accurate mirror of the server's current page set rather than an
ever-growing accumulation of removed pages.

``repo_full_name`` is caller-supplied for the same reason as
:mod:`agentrail.context.wiki_push` — see that module's docstring.
"""
from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

from agentrail.context.snapshot_push import load_link

# Short, same as snapshot_push/memory_fetch: a slow server must never stall a
# compile.
WIKI_FETCH_TIMEOUT_SECONDS = 5

# A local cache younger than this is considered fresh and skips the network
# round trip. Same value + rationale as memory_fetch.MEMORY_SNAPSHOT_TTL_SECONDS:
# comfortably covers one compile's worth of activity while still picking up
# server-side changes between runs.
WIKI_SNAPSHOT_TTL_SECONDS = 300.0

WIKI_DIR_REL = ".agentrail/context/wiki"
WIKI_MANIFEST_REL = ".agentrail/context/wiki/manifest.json"

_SLUG_UNIT_RE = re.compile(r"^wiki/unit/(.+)$")


def wiki_page_filename(slug: str) -> str:
    """Deterministic slug -> filename mapping.

    ``"wiki/overview"`` -> ``"overview.md"``; ``"wiki/unit/<unit-id>"`` ->
    ``"unit__<unit-id>.md"``. Any other/unrecognized slug shape falls back to
    replacing every ``/`` with ``__`` — which also means no ``/`` ever
    survives into the returned filename, so joining it onto the wiki dir can
    never escape that directory (path-traversal-safe by construction, not by
    validation).
    """
    if slug == "wiki/overview":
        return "overview.md"
    match = _SLUG_UNIT_RE.match(slug)
    if match:
        return f"unit__{match.group(1)}.md"
    return slug.replace("/", "__") + ".md"


def _page_frontmatter(page: Dict[str, Any]) -> str:
    """Render the YAML frontmatter block mirroring spec §4.1's shape."""
    citations = page.get("citations")
    citations = citations if isinstance(citations, list) else []
    citations_yaml = "[]" if not citations else "[" + ", ".join(str(c) for c in citations) + "]"
    lines = [
        "---",
        f"slug: {page.get('slug', '')}",
        f"title: {page.get('title', '')}",
        f"kind: {page.get('kind', '')}",
        f"commitSha: {page.get('commitSha', '')}",
        f"inputsHash: {page.get('inputsHash', '')}",
        f"generatedAt: {page.get('generatedAt', '')}",
        f"model: {page.get('model') or ''}",
        f"citations: {citations_yaml}",
        "---",
        "",
    ]
    return "\n".join(lines)


def _write_page_file(wiki_dir: Path, page: Dict[str, Any]) -> str:
    """Write one page's markdown file; returns the filename written (or "" if skipped)."""
    slug = str(page.get("slug") or "")
    if not slug:
        return ""
    filename = wiki_page_filename(slug)
    body_md = str(page.get("bodyMd") or "")
    content = _page_frontmatter(page) + body_md
    if not content.endswith("\n"):
        content += "\n"
    (wiki_dir / filename).write_text(content, encoding="utf-8")
    return filename


def fetch_wiki_snapshot(
    target: Path,
    repo_full_name: str,
    *,
    ttl_seconds: float = WIKI_SNAPSHOT_TTL_SECONDS,
) -> bool:
    """Refresh ``<target>/{WIKI_MANIFEST_REL}`` + per-page markdown from the
    linked server.

    Returns True when the local cache is usable-fresh (just written, or
    already younger than *ttl_seconds*); False when the repo is unlinked or
    the fetch failed for any reason. Never raises, and never removes existing
    files on a FAILED fetch — callers may treat the result as purely
    advisory (the compiler's own ``inputsHash`` diff is the correctness
    backstop; this is only an amortization cache). Pass ``ttl_seconds=0`` to
    force a refetch.
    """
    try:
        manifest_path = Path(target) / WIKI_MANIFEST_REL
        if ttl_seconds > 0 and manifest_path.exists():
            age = time.time() - manifest_path.stat().st_mtime
            # Negative age = mtime in the future (clock skew); treat as stale.
            if 0 <= age < ttl_seconds:
                return True

        link = load_link(Path(target))
        if link is None:
            return False

        url = (
            f"{link['base_url']}/api/v1/context/wiki-pages?"
            + urllib.parse.urlencode({"repo": repo_full_name})
        )
        req = urllib.request.Request(
            url,
            headers={"Authorization": f"Bearer {link['api_key']}"},
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=WIKI_FETCH_TIMEOUT_SECONDS) as resp:
            if int(getattr(resp, "status", 200)) != 200:
                return False
            payload = json.loads(resp.read().decode("utf-8"))

        pages = payload.get("pages") if isinstance(payload, dict) else None
        if not isinstance(pages, list):
            return False
        # Server bytes must never be able to crash a compile: keep only
        # dict-shaped rows (mirrors fetch_memory_snapshot's read-side guard).
        pages = [p for p in pages if isinstance(p, dict)]

        wiki_dir = Path(target) / WIKI_DIR_REL
        wiki_dir.mkdir(parents=True, exist_ok=True)

        manifest_pages: List[Dict[str, Any]] = []
        written_filenames = set()
        for page in pages:
            filename = _write_page_file(wiki_dir, page)
            if not filename:
                continue
            written_filenames.add(filename)
            manifest_pages.append(
                {
                    "slug": page.get("slug"),
                    "inputsHash": page.get("inputsHash"),
                    "stale": bool(page.get("stale", False)),
                }
            )

        # Prune any page file from a prior fetch that the server no longer
        # lists (a removed unit, a renamed slug) — see module docstring for
        # why this is safe: nothing else writes into this generated-cache dir.
        for existing_file in wiki_dir.glob("*.md"):
            if existing_file.name not in written_filenames:
                try:
                    existing_file.unlink()
                except OSError:
                    pass

        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(
            json.dumps(
                {
                    "repo": repo_full_name,
                    "fetchedAt": datetime.now(timezone.utc).isoformat(),
                    "pages": manifest_pages,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        return True
    except Exception:  # noqa: BLE001 — non-fatal by design, like memory_fetch
        return False

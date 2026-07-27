"""Read-only client for the server's compiled Repo Wiki — no clone-side cache.

Context source registry spec §G, step 2 of §K
(docs/superpowers/specs/2026-07-27-context-source-registry-design.md).

``wiki_pages`` in Postgres is the Repo Wiki's system of record (owner ruling,
2026-07-23). :mod:`agentrail.context.wiki_fetch` materializes it into
``.agentrail/context/wiki/`` so the COMPILER can hash-diff against a durable
copy instead of regenerating every page from zero. This module is the other
half: reading pages for a HUMAN or an AGENT to look at, which needs no
materialization at all.

The distinction matters because the two have opposite failure modes. Hydration
must leave a usable cache behind even when the network is flaky, so it writes.
A read must never leave anything behind — an executor running
``agentrail context wiki show`` inside an ephemeral clone should not silently
seed a directory that a later compile then treats as authoritative.

WRITES: nothing. Ever. This module has no filesystem write path.

FALLBACK: every entry point returns ``None`` when the repo is unlinked, has no
resolvable GitHub ``origin``, or the fetch fails for any reason — callers fall
back to the local-file readers in :mod:`agentrail.context.wiki` (``wiki_status``
/ ``wiki_show``), which still work in a hydrated clone and offline. ``None``
means "I could not answer", never "there is no wiki"; the two are different and
a caller that conflates them will report an empty wiki during an outage.

Not gated on ``AGENTRAIL_CONTEXT_REPO_WIKI``: that flag gates the COMPILER
(whether ``build_index`` spends time and money producing pages), not whether a
human or agent may read pages that already exist. ``wiki status``/``show`` are
ungated today for the same reason.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

from agentrail.context.snapshot_push import load_link
from agentrail.context.wiki_fetch import WIKI_FETCH_TIMEOUT_SECONDS, render_page_text

# Above this page count, ranking the full page set locally stops being
# defensible and search belongs on the server (spec §G's open question). The
# ceiling is enforced by REPORTING it, not by refusing to answer: a truncated
# ranking that claims to be complete is worse than a complete one that admits
# its cost. Today's largest real wiki is 64 pages (Bensigo/agentrail), so this
# is headroom, not a live constraint.
LOCAL_RANK_PAGE_CEILING = 200


def _fetch_payload(target: Path, repo_full_name: str) -> Optional[Dict[str, Any]]:
    """GET the workspace's wiki pages for *repo_full_name*, or None.

    Deliberately silent on every failure path (unlinked, HTTP error, bad
    JSON, timeout): the caller's contract is "fall back to local", and a
    traceback on a read command that has a working fallback is noise.
    """
    link = load_link(target)
    if link is None:
        return None
    url = (
        f"{link['base_url']}/api/v1/context/wiki-pages?"
        + urllib.parse.urlencode({"repo": repo_full_name})
    )
    request = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {link['api_key']}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=WIKI_FETCH_TIMEOUT_SECONDS) as response:
            if int(getattr(response, "status", 200)) != 200:
                return None
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError, KeyError):
        return None
    return payload if isinstance(payload, dict) else None


def remote_pages(target: Path, *, repo_full_name: Optional[str] = None) -> Optional[List[Dict[str, Any]]]:
    """Every compiled page for this clone's repo, newest server state, or None.

    Server bytes must never crash a read: non-dict rows and rows without a
    slug are dropped rather than trusted (same read-side guard as
    ``fetch_wiki_snapshot``'s).
    """
    if repo_full_name is None:
        from agentrail.shared.git import origin_repo_full_name

        repo_full_name = origin_repo_full_name(target)
    if not repo_full_name:
        return None
    payload = _fetch_payload(target, repo_full_name)
    if payload is None:
        return None
    pages = payload.get("pages")
    if not isinstance(pages, list):
        return None
    return [page for page in pages if isinstance(page, dict) and page.get("slug")]


def remote_status(target: Path, *, repo_full_name: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """``wiki.wiki_status``-shaped view of the SERVER's pages, or None.

    Same keys as the local reader so the CLI renderer is shared, with two
    honest differences:

    * ``file`` is None — a server page has no path in this clone.
    * ``currentInputsHash`` is None and ``stale`` comes from the server's own
      flag rather than a local hash diff. The server computed staleness
      against the commit the wiki was compiled from; this clone may sit on a
      different commit, so recomputing here would answer a different question
      than the console shows for the same page.

    ``ageSeconds`` is deliberately absent for the same reason ``file`` is:
    the local reader derives it from a hydrated file's frontmatter, and the
    server gives ``generatedAt`` directly — a caller that wants an age can
    subtract, and one that does not should not be handed a computed value
    whose clock basis differs from the local path's.
    """
    pages = remote_pages(target, repo_full_name=repo_full_name)
    if pages is None:
        return None
    return {
        "compiled": bool(pages),
        "compiledAt": max((str(p.get("generatedAt") or "") for p in pages), default=None) or None,
        "commitSha": next((str(p["commitSha"]) for p in pages if p.get("commitSha")), None),
        "origin": "server",
        "pages": [
            {
                "slug": page.get("slug"),
                "file": None,
                "inputsHash": page.get("inputsHash"),
                "currentInputsHash": None,
                "stale": bool(page.get("stale", False)),
                "generatedAt": page.get("generatedAt") if isinstance(page.get("generatedAt"), str) else None,
                "ageSeconds": None,
                "model": page.get("model"),
            }
            for page in pages
        ],
    }


def remote_show(target: Path, slug: str, *, repo_full_name: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """``wiki.wiki_show``-shaped view of ONE server page, or None.

    ``None`` means "could not reach the server" — NOT "no such page". A
    reachable server that has no page for *slug* returns a dict with
    ``found`` False, so the caller can tell an outage (fall back to local)
    from a genuinely missing slug (report it, and do not pretend the local
    cache is authoritative).
    """
    pages = remote_pages(target, repo_full_name=repo_full_name)
    if pages is None:
        return None
    match = next((page for page in pages if str(page.get("slug")) == slug), None)
    if match is None:
        return {"found": False, "slug": slug, "slugs": [str(p.get("slug")) for p in pages]}
    text = render_page_text(match)
    return {
        "found": True,
        "slug": slug,
        "file": None,
        "origin": "server",
        "frontmatter": {
            "slug": match.get("slug"),
            "title": match.get("title"),
            "kind": match.get("kind"),
            "commitSha": match.get("commitSha"),
            "inputsHash": match.get("inputsHash"),
            "generatedAt": match.get("generatedAt"),
            "model": match.get("model"),
            "citations": match.get("citations") if isinstance(match.get("citations"), list) else [],
            "stale": bool(match.get("stale", False)),
        },
        "body": str(match.get("bodyMd") or ""),
        "text": text,
    }


def local_pages(target: Path) -> List[Dict[str, Any]]:
    """The same page shape, assembled from a hydrated clone's files.

    The offline half of :func:`remote_pages`, so :func:`rank_pages` can serve
    ``wiki search`` whether or not the server is reachable. Returns ``[]``
    when nothing is hydrated — an empty list, not None: "I looked locally and
    there is nothing" is a real answer, unlike a failed fetch.
    """
    from agentrail.context.wiki import WikiPageNotFoundError, wiki_show, wiki_status

    status = wiki_status(target)
    if not status.get("compiled"):
        return []
    pages: List[Dict[str, Any]] = []
    for entry in status.get("pages", []):
        slug = str(entry.get("slug") or "")
        if not slug:
            continue
        try:
            page = wiki_show(target, slug)
        except (WikiPageNotFoundError, ValueError, OSError):
            continue
        frontmatter = page.get("frontmatter") or {}
        pages.append({
            "slug": slug,
            "title": frontmatter.get("title"),
            "kind": frontmatter.get("kind"),
            "bodyMd": page.get("body") or "",
            "stale": bool(entry.get("stale", False)),
        })
    return pages


def _snippet(body: str, terms: List[str], *, width: int = 200) -> str:
    """First line of *body* that mentions any term, trimmed — else the opening.

    A discovery aid, not a summary: the agent decides from it whether the
    whole page is worth reading, so a matched line beats a generic first
    paragraph.
    """
    lowered_terms = [term for term in terms if term]
    for line in body.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        low = stripped.lower()
        if any(term in low for term in lowered_terms):
            return stripped[:width]
    for line in body.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            return stripped[:width]
    return ""


def rank_pages(pages: List[Dict[str, Any]], query: str, *, limit: int = 5) -> List[Dict[str, Any]]:
    """Rank whole PAGES against *query* — a page-picker, not a chunk ranker.

    Scoring is deliberately simple and deliberately NOT the pack's ranker:
    matched query terms, counted once per page (presence, not frequency), with
    title and slug matches weighted above body matches because a page whose
    TITLE names the term is about the term, while a body mention may be a
    passing reference.

    Tokenization is borrowed from ``retrieval.tokenize`` so a term that the
    pack ranker would treat as one token is treated as one token here too — a
    query for ``query_context`` must not silently split differently in the two
    places an agent might type it.

    Presence-not-frequency is the important choice: page lengths here differ by
    an order of magnitude (a one-module leaf vs the overview), and raw term
    frequency would hand every query to the longest page. Proper length
    normalization is the pack ranker's job (spec §E); this function's job is
    only to answer "which page should I open first?", and it must not be
    mistaken for the retrieval quality bar that §G sets for ``wiki.search``.
    """
    from agentrail.context.retrieval import tokenize

    terms = sorted(set(tokenize(query)))
    if not terms:
        return []
    ranked = []
    for page in pages:
        slug = str(page.get("slug") or "")
        title = str(page.get("title") or "")
        body = str(page.get("bodyMd") or "")
        haystack_title = set(tokenize(f"{title} {slug}"))
        haystack_body = set(tokenize(body))
        matched_title = [term for term in terms if term in haystack_title]
        matched_body = [term for term in terms if term in haystack_body and term not in haystack_title]
        if not matched_title and not matched_body:
            continue
        score = 2.0 * len(matched_title) + 1.0 * len(matched_body)
        # A stale page still answers "where does this live", so it ranks —
        # but never above a fresh page that matched just as well. Same
        # intent as retrieval.wiki_page_freshness, applied at page grain.
        if page.get("stale"):
            score -= 0.5
        ranked.append({
            "slug": slug,
            "title": title or None,
            "kind": page.get("kind"),
            "score": round(score, 3),
            "stale": bool(page.get("stale", False)),
            "matched": matched_title + matched_body,
            "snippet": _snippet(body, matched_title + matched_body),
        })
    ranked.sort(key=lambda item: (-item["score"], item["slug"]))
    return ranked[:limit]

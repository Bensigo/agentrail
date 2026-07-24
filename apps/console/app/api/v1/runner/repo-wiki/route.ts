/**
 * GET /api/v1/runner/repo-wiki?eveSessionId=<id>&mode=list|get|search&repo=<fullName>&slug=<slug>&query=<text>&limit=<n>
 *
 * Repo Wiki spec §4.4 contract 3 (delivery plan §7 row 4). The route Jace's
 * `fetch_repo_wiki` tool (PR 5/7) reads through — read-only, no second write
 * path (§4.7).
 *
 * AUTH + TENANT: identical resolution chain to `runner/workspace-memory` (see
 * that route's own doc-comment for the full rationale). The central
 * `JACE_CONSOLE_TOKEN` secret via `requireJaceConsoleSecret` gates WHO may
 * call this route; WHICH workspace is resolved server-side from the
 * caller-supplied `eveSessionId` through the `jace_sessions` ledger
 * (`getJaceSessionByEveSessionId`) — never trusted as a caller-supplied
 * `workspaceId` directly.
 *
 * REPO RESOLUTION: `repo` (full name, e.g. "owner/name") is optional. When
 * given, it is resolved scoped to the ledgered workspace. When omitted, the
 * workspace's repositories are listed; if there is exactly one, it is used
 * automatically (the common case — most workspaces link one repo), otherwise
 * the caller must disambiguate: 400 `{ error: "repo_required", repos:
 * [fullNames] }`.
 *
 * MODES:
 *   list   — every page, `bodyMd` omitted. Ordered "wiki/overview" first
 *            then units alphabetically (falls out of `listWikiPages`'s plain
 *            `ORDER BY slug` — see its doc comment).
 *   get    — one page by `slug` (required). Full `bodyMd` + `citations`
 *            (the only mode that returns citations).
 *   search — FTS over `body_md` (`query`, optional — an empty query is
 *            navigational, not an error), ranked, capped at `limit`
 *            (default 5, max 10). `bodyMd` truncated to its first 2000
 *            characters — a preview, not the full page (call `get` for
 *            that). Falls back to the most recently generated pages on zero
 *            FTS hits (mirrors `retrieveMemory`'s own fallback).
 *
 * 400 — missing/blank `eveSessionId`, invalid/missing `mode`, ambiguous repo,
 * or a `get` with no `slug`. 401 — bad/missing shared secret. 404 — no
 * session, a session with no resolved workspace yet, an explicit `repo` not
 * found in the workspace, or (mode=get) no page at that slug. 502 — the
 * backing store errored. 200 — `{ schemaVersion: 1, repo, mode, pages: [...] }`.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  getJaceSessionByEveSessionId,
  getRepositoryByName,
  getWikiPage,
  listWikiPages,
  listWorkspaceRepositories,
  searchWikiPages,
  WIKI_SEARCH_DEFAULT_LIMIT,
  WIKI_SEARCH_MAX_LIMIT,
} from "@agentrail/db-postgres";
import type { WikiPage } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";

const MODES = ["list", "get", "search"] as const;
type Mode = (typeof MODES)[number];

const WIKI_SEARCH_BODY_PREVIEW_CHARS = 2000;

interface WirePage {
  slug: string;
  title: string;
  kind: string;
  stale: boolean;
  commitSha: string;
  generatedAt: string;
  model: string | null;
  bodyMd?: string;
  citations?: string[];
}

function toListPage(p: WikiPage): WirePage {
  return {
    slug: p.slug,
    title: p.title,
    kind: p.kind,
    stale: p.stale,
    commitSha: p.commitSha,
    generatedAt: p.generatedAt.toISOString(),
    model: p.model,
  };
}

function toGetPage(p: WikiPage): WirePage {
  return { ...toListPage(p), bodyMd: p.bodyMd, citations: p.citations };
}

function toSearchPage(p: WikiPage): WirePage {
  return { ...toListPage(p), bodyMd: p.bodyMd.slice(0, WIKI_SEARCH_BODY_PREVIEW_CHARS) };
}

export async function GET(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;

  const eveSessionId = request.nextUrl.searchParams.get("eveSessionId")?.trim() ?? "";
  if (!eveSessionId) {
    return NextResponse.json({ error: "eveSessionId is required" }, { status: 400 });
  }

  const session = await getJaceSessionByEveSessionId(eveSessionId);
  const workspaceId = session?.workspaceId ?? null;
  if (!workspaceId) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const modeParam = request.nextUrl.searchParams.get("mode") ?? "";
  if (!(MODES as readonly string[]).includes(modeParam)) {
    return NextResponse.json(
      { error: "mode must be one of list, get, search" },
      { status: 400 }
    );
  }
  const mode = modeParam as Mode;

  const repoParam = request.nextUrl.searchParams.get("repo")?.trim() ?? "";
  let repo: { id: string; name: string };
  try {
    if (repoParam) {
      const found = await getRepositoryByName(workspaceId, repoParam);
      if (!found) {
        return NextResponse.json(
          { error: `Repository ${repoParam} not found in this workspace` },
          { status: 404 }
        );
      }
      repo = found;
    } else {
      const repos = await listWorkspaceRepositories(workspaceId);
      if (repos.length !== 1) {
        return NextResponse.json(
          { error: "repo_required", repos: repos.map((r) => r.name) },
          { status: 400 }
        );
      }
      repo = repos[0]!;
    }
  } catch (err) {
    console.error("[runner/repo-wiki] repo resolution failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }

  try {
    if (mode === "get") {
      const slug = request.nextUrl.searchParams.get("slug")?.trim() ?? "";
      if (!slug) {
        return NextResponse.json({ error: "slug is required for mode=get" }, { status: 400 });
      }
      const page = await getWikiPage(workspaceId, repo.id, slug);
      if (!page) {
        return NextResponse.json(
          { error: `Wiki page ${slug} not found for ${repo.name}` },
          { status: 404 }
        );
      }
      return NextResponse.json({
        schemaVersion: 1,
        repo: repo.name,
        mode,
        pages: [toGetPage(page)],
      });
    }

    if (mode === "search") {
      const query = request.nextUrl.searchParams.get("query")?.trim() ?? "";
      const limitParam = request.nextUrl.searchParams.get("limit");
      let limit = WIKI_SEARCH_DEFAULT_LIMIT;
      if (limitParam !== null) {
        const parsed = Number(limitParam);
        if (Number.isFinite(parsed)) {
          limit = Math.min(WIKI_SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(parsed)));
        }
      }
      const pages = await searchWikiPages(workspaceId, repo.id, query, limit);
      return NextResponse.json({
        schemaVersion: 1,
        repo: repo.name,
        mode,
        pages: pages.map(toSearchPage),
      });
    }

    // mode === "list"
    const pages = await listWikiPages(workspaceId, repo.id);
    return NextResponse.json({
      schemaVersion: 1,
      repo: repo.name,
      mode,
      pages: pages.map(toListPage),
    });
  } catch (err) {
    console.error("[runner/repo-wiki] read failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }
}

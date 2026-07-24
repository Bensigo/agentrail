/**
 * GET /api/v1/context/wiki-pages?repo=<fullName>
 *
 * Repo Wiki spec §4.4 contract 2 (delivery plan §7 row 4). Machine-rail read
 * endpoint for the factory's hydration client — `agentrail/context/wiki_fetch.py`
 * calls this before compiling so a fresh ephemeral clone starts from the
 * server's durable copy instead of recompiling every page from zero (§4.2
 * "why hydration is load-bearing"). Mirrors `context/memory-items`'s role for
 * `memory_fetch.py` exactly, including bearer auth (machine trust) and
 * returning content UNMASKED — this is a separate route from any future
 * session-authed, human-facing wiki view (console PR 6), which is untouched
 * by this route.
 *
 * Authenticates via bearer API key. workspace_id comes from the key; `repo`
 * (the repository's full name, e.g. "owner/name" — NOT its id) is resolved
 * to a repository scoped to that workspace.
 *
 * Returns: 200 { schemaVersion: 1, repo, pages: [{ slug, title, kind, bodyMd,
 * skeleton, links, citations, commitSha, inputsHash, model, writtenBy,
 * generatedAt, stale }] } — every page, full content, ordered "wiki/overview"
 * first then units alphabetically (see `listWikiPages`'s doc comment for why
 * that ordering falls out of a plain `ORDER BY slug`).
 */
import { NextRequest, NextResponse } from "next/server";
import { getRepositoryByName, listWikiPages, touchApiKeyLastUsed } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

export async function GET(request: NextRequest) {
  const auth = await requireBearer(request);
  if (auth instanceof NextResponse) return auth;

  const repoFullName = new URL(request.url).searchParams.get("repo")?.trim() ?? "";
  if (!repoFullName) {
    return NextResponse.json({ error: "repo query parameter is required" }, { status: 400 });
  }

  try {
    // Scope check: the key's workspace must own the repository. A foreign
    // repo full name looks identical to a missing one (no cross-workspace
    // existence oracle) — mirrors context/memory-items' own repo check.
    const repo = await getRepositoryByName(auth.workspaceId, repoFullName);
    if (!repo) {
      return NextResponse.json(
        { error: `Repository ${repoFullName} not found in this workspace` },
        { status: 404 }
      );
    }

    const pages = await listWikiPages(auth.workspaceId, repo.id);

    await touchApiKeyLastUsed(auth.apiKeyId);
    return NextResponse.json({
      schemaVersion: 1,
      repo: repoFullName,
      pages: pages.map((p) => ({
        slug: p.slug,
        title: p.title,
        kind: p.kind,
        bodyMd: p.bodyMd,
        skeleton: p.skeleton,
        links: p.links,
        citations: p.citations,
        commitSha: p.commitSha,
        inputsHash: p.inputsHash,
        model: p.model,
        writtenBy: p.writtenBy,
        generatedAt: p.generatedAt.toISOString(),
        stale: p.stale,
      })),
    });
  } catch (err) {
    console.error("[context/wiki-pages] failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }
}

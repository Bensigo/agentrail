/**
 * POST /api/v1/ingest/wiki-pages
 *
 * Repo Wiki spec §4.4 contract 1 (delivery plan §7 row 4). Upserts compiled
 * wiki pages emitted by the compiler (PR 2/7, still flag-OFF) into Postgres,
 * and — when the push includes one — records a `compileEvent` into
 * ClickHouse's append-only `wiki_compile_events` history.
 *
 * Authenticates via bearer API key (see lib/bearer-auth.ts). workspace_id
 * comes from the key; `repoFullName` is resolved to a repository scoped to
 * that workspace (never trusted as an id — mirrors every other repo-scoped
 * ingest route). Body content is scanned for credential-shaped values before
 * anything is written, mirroring ingest/memory-items' write-side secret scan
 * exactly: reject the WHOLE batch on any hit, fail closed.
 *
 * Body: { repoFullName: string, pages: Page[], compileEvent?: CompileEvent }
 *   Page (PAGE minus `stale` — the ingest route owns freshness, not the
 *   pusher): { slug, title, kind: "overview"|"unit", bodyMd, skeleton?,
 *   links?, citations?, commitSha, inputsHash, model?, writtenBy?,
 *   generatedAt }
 *   CompileEvent: { commitSha, pagesWritten, pagesReused, costUsd, model,
 *   durationMs }
 *
 * Every upserted row's `stale` is forced to `false` — a pushed page is fresh
 * as of this push, by contract (see `upsertWikiPages`'s doc comment for what
 * sets it true, which is nothing in this PR's scope).
 *
 * The ClickHouse compile-event write is NON-FATAL: Postgres (the system of
 * record) already has the durable page content by the time it runs, and
 * ClickHouse here is secondary observability history — losing one compile's
 * cost/duration telemetry to a transient ClickHouse hiccup must never make
 * the whole push look like it failed (the pages are already safely stored).
 *
 * Returns: 200 { inserted, replaced }
 */
import { NextRequest, NextResponse } from "next/server";
import { getRepositoryByName, upsertWikiPages } from "@agentrail/db-postgres";
import type { UpsertWikiPageInput } from "@agentrail/db-postgres";
import { insertWikiCompileEvents } from "@agentrail/db-clickhouse";
import { requireBearer } from "../../../../../lib/bearer-auth";
import { scanForSecrets, summarizeFindings } from "../../../../../lib/secret-scan";

// §4.1's page budget: ≤ 24 unit pages + 1 overview per repo. A generous
// margin over that cap guards against a malformed/runaway payload without
// ever rejecting a legitimate push.
const MAX_PAGES_PER_PUSH = 40;

const WIKI_PAGE_KINDS = ["overview", "unit"] as const;
type WikiPageKindLiteral = (typeof WIKI_PAGE_KINDS)[number];

interface RawWikiPageLinks {
  related: string[];
  dependsOn: string[];
  dependedOnBy: string[];
}

interface RawWikiPage {
  slug: string;
  title: string;
  kind: WikiPageKindLiteral;
  bodyMd: string;
  skeleton?: Record<string, unknown>;
  links?: RawWikiPageLinks;
  citations?: string[];
  commitSha: string;
  inputsHash: string;
  model?: string | null;
  writtenBy?: string;
  generatedAt: string;
}

interface RawCompileEvent {
  commitSha: string;
  pagesWritten: number;
  pagesReused: number;
  costUsd: number;
  model: string;
  durationMs: number;
}

interface RawBody {
  repoFullName: string;
  pages: RawWikiPage[];
  compileEvent?: RawCompileEvent;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

function isRawLinks(v: unknown): v is RawWikiPageLinks {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return isStringArray(o.related) && isStringArray(o.dependsOn) && isStringArray(o.dependedOnBy);
}

function isRawWikiPage(v: unknown): v is RawWikiPage {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (
    typeof o.slug !== "string" ||
    o.slug.trim().length === 0 ||
    typeof o.title !== "string" ||
    !(WIKI_PAGE_KINDS as readonly string[]).includes(o.kind as string) ||
    typeof o.bodyMd !== "string" ||
    typeof o.commitSha !== "string" ||
    typeof o.inputsHash !== "string" ||
    typeof o.generatedAt !== "string"
  ) {
    return false;
  }
  if (o.skeleton !== undefined && (typeof o.skeleton !== "object" || o.skeleton === null)) {
    return false;
  }
  if (o.links !== undefined && !isRawLinks(o.links)) return false;
  if (o.citations !== undefined && !isStringArray(o.citations)) return false;
  if (o.model !== undefined && o.model !== null && typeof o.model !== "string") return false;
  if (o.writtenBy !== undefined && typeof o.writtenBy !== "string") return false;
  return true;
}

function isRawCompileEvent(v: unknown): v is RawCompileEvent {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.commitSha === "string" &&
    typeof o.pagesWritten === "number" &&
    typeof o.pagesReused === "number" &&
    typeof o.costUsd === "number" &&
    typeof o.model === "string" &&
    typeof o.durationMs === "number"
  );
}

function isRawBody(v: unknown): v is RawBody {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (
    typeof o.repoFullName !== "string" ||
    o.repoFullName.trim().length === 0 ||
    !Array.isArray(o.pages) ||
    !(o.pages as unknown[]).every(isRawWikiPage)
  ) {
    return false;
  }
  if (o.compileEvent !== undefined && !isRawCompileEvent(o.compileEvent)) return false;
  return true;
}

export async function POST(req: NextRequest) {
  const auth = await requireBearer(req);
  if (auth instanceof NextResponse) return auth;
  const { workspaceId } = auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!isRawBody(body)) {
    return NextResponse.json(
      {
        error:
          "Body must have repoFullName (string), pages (array of {slug, title, kind, bodyMd, commitSha, inputsHash, generatedAt})",
      },
      { status: 400 }
    );
  }

  if (body.pages.length > MAX_PAGES_PER_PUSH) {
    return NextResponse.json(
      { error: `pages batch exceeds the ${MAX_PAGES_PER_PUSH}-page limit` },
      { status: 400 }
    );
  }

  const repo = await getRepositoryByName(workspaceId, body.repoFullName);
  if (!repo) {
    return NextResponse.json(
      { error: `Repository ${body.repoFullName} not found in this workspace` },
      { status: 404 }
    );
  }

  // Write-side secret scan (mirrors ingest/memory-items exactly): body_md is
  // injected verbatim into agent prompts and rendered verbatim by the
  // console (§4.5 "what you see is what the LLM sees"), so a credential
  // persisted here is a real exfiltration surface. Reject the whole batch on
  // any hit — fail closed — before anything reaches storage.
  const secretFindings = body.pages.flatMap((p) => scanForSecrets(p.bodyMd).findings);
  if (secretFindings.length > 0) {
    const reason = summarizeFindings(secretFindings);
    console.warn(
      `[ingest/wiki-pages] rejected batch for repo ${body.repoFullName}: ${reason}`
    );
    return NextResponse.json(
      {
        error: "Wiki page content rejected: credential-shaped value detected",
        reason,
      },
      { status: 422 }
    );
  }

  const pages: UpsertWikiPageInput[] = body.pages.map((p) => ({
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
    generatedAt: p.generatedAt,
  }));

  let result;
  try {
    result = await upsertWikiPages({
      workspaceId,
      repositoryId: repo.id,
      pages,
    });
  } catch (err) {
    console.error("[ingest/wiki-pages] Postgres upsert failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }

  if (body.compileEvent) {
    try {
      await insertWikiCompileEvents([
        {
          workspace_id: workspaceId,
          repository_id: repo.id,
          commit_sha: body.compileEvent.commitSha,
          pages_written: body.compileEvent.pagesWritten,
          pages_reused: body.compileEvent.pagesReused,
          cost_usd: body.compileEvent.costUsd,
          model: body.compileEvent.model,
          duration_ms: body.compileEvent.durationMs,
          created_at: new Date().toISOString(),
        },
      ]);
    } catch (err) {
      // Non-fatal: the Postgres write already succeeded (see doc comment).
      console.error(
        "[ingest/wiki-pages] ClickHouse compile-event insert failed (non-fatal):",
        err
      );
    }
  }

  return NextResponse.json(
    { inserted: result.inserted, replaced: result.replaced },
    { status: 200 }
  );
}

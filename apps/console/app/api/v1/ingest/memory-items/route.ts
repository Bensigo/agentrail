/**
 * POST /api/v1/ingest/memory-items
 *
 * Inserts memory items emitted from review output into Postgres.
 * Authenticates via bearer API key (see lib/bearer-auth.ts).
 * workspace_id comes from the API key; repository_id is validated.
 *
 * Body: { run_id, repository_id, items: [{ content, tags[], type? }],
 *         written_by?, source? }
 * `type` (per item), `written_by` and `source` (batch-level) are OPTIONAL and
 * backward compatible: when omitted, source defaults to "review", writtenBy
 * falls back to source, and each item's type falls back to "fact" downstream.
 * Returns: 202 { ok: true }
 */
import { NextRequest, NextResponse } from "next/server";
import {
  getRepository,
  insertMemoryItems,
  replaceMemoryItemsByWriter,
} from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";
import { scanForSecrets, summarizeFindings } from "../../../../../lib/secret-scan";

// Mirrors the `memory_type` enum (packages/db-postgres schema / MemoryType).
// Kept as a local const so the validator can reject unknown values at the edge.
const MEMORY_TYPES = ["decision", "preference", "fact"] as const;
type MemoryTypeLiteral = (typeof MEMORY_TYPES)[number];

interface RawMemoryItem {
  content: string;
  tags: string[];
  type?: MemoryTypeLiteral;
}

interface RawBody {
  run_id: string;
  repository_id: string;
  written_by?: string;
  source?: string;
  replace_by_writer?: boolean;
  items: RawMemoryItem[];
}

function isRawMemoryItem(v: unknown): v is RawMemoryItem {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (
    typeof o.content !== "string" ||
    o.content.trim().length === 0 ||
    !Array.isArray(o.tags) ||
    !(o.tags as unknown[]).every((t) => typeof t === "string")
  ) {
    return false;
  }
  // `type` is optional; when present it must be one of the enum values.
  if (
    o.type !== undefined &&
    !(MEMORY_TYPES as readonly string[]).includes(o.type as string)
  ) {
    return false;
  }
  return true;
}

function isRawBody(v: unknown): v is RawBody {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (
    typeof o.run_id !== "string" ||
    typeof o.repository_id !== "string" ||
    !Array.isArray(o.items) ||
    !(o.items as unknown[]).every(isRawMemoryItem)
  ) {
    return false;
  }
  // Optional batch-level attribution; strings when present.
  if (o.written_by !== undefined && typeof o.written_by !== "string") return false;
  if (o.source !== undefined && typeof o.source !== "string") return false;
  // Optional idempotent re-seed flag; boolean when present.
  if (o.replace_by_writer !== undefined && typeof o.replace_by_writer !== "boolean")
    return false;
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
          "Body must have run_id (string), repository_id (string), items (array of {content, tags[]})",
      },
      { status: 400 }
    );
  }

  const repo = await getRepository(workspaceId, body.repository_id);
  if (!repo) {
    return NextResponse.json(
      { error: `Repository ${body.repository_id} not found in this workspace` },
      { status: 404 }
    );
  }

  // Write-side secret scan (#1032). Memory content is injected verbatim into
  // agent prompts, so a credential persisted here can be exfiltrated to any run
  // in the workspace. Reject the whole batch if ANY item is credential-shaped —
  // fail closed — and record a non-sensitive reason (kinds only, never the
  // matched value). This runs before insert so a secret never reaches storage.
  const secretFindings = body.items.flatMap(
    (item) => scanForSecrets(item.content).findings
  );
  if (secretFindings.length > 0) {
    const reason = summarizeFindings(secretFindings);
    console.warn(
      `[ingest/memory-items] rejected batch for run ${body.run_id}: ${reason}`
    );
    return NextResponse.json(
      {
        error: "Memory content rejected: credential-shaped value detected",
        reason,
      },
      { status: 422 }
    );
  }

  const runTag = `run:${body.run_id}`;
  const itemsWithRunTag = body.items.map((item) => ({
    content: item.content,
    tags: item.tags.includes(runTag) ? item.tags : [...item.tags, runTag],
    type: item.type,
  }));

  try {
    // Idempotent re-seed: when the caller asks to replace and identifies the
    // writer (and repo), atomically delete prior rows for that writer then
    // insert this batch — so re-running onboarding does not accumulate dupes.
    // Requires a non-empty writtenBy: without a writer there is nothing to
    // scope the delete to, so fall back to the plain insert path.
    if (
      body.replace_by_writer === true &&
      body.written_by &&
      body.repository_id
    ) {
      await replaceMemoryItemsByWriter({
        workspaceId,
        repositoryId: body.repository_id,
        writtenBy: body.written_by,
        source: body.source ?? "review",
        items: itemsWithRunTag.map((it) => ({
          content: it.content,
          tags: it.tags,
          type: it.type,
        })),
      });
    } else {
      await insertMemoryItems({
        workspaceId,
        repositoryId: body.repository_id,
        // Defaults preserve prior behavior: source "review", writtenBy falls back
        // to source, and each item's type falls back to "fact" inside the query.
        source: body.source ?? "review",
        writtenBy: body.written_by,
        items: itemsWithRunTag.map((it) => ({
          content: it.content,
          tags: it.tags,
          type: it.type,
        })),
      });
    }
  } catch (err) {
    console.error("[ingest/memory-items] Postgres insert failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }

  return NextResponse.json({ ok: true }, { status: 202 });
}

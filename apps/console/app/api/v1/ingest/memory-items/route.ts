/**
 * POST /api/v1/ingest/memory-items
 *
 * Inserts memory items emitted from review output into Postgres.
 * Authenticates via bearer API key (see lib/bearer-auth.ts).
 * workspace_id comes from the API key; repository_id is validated.
 *
 * Body: { run_id, repository_id, items: [{ content, tags[] }] }
 * Returns: 202 { ok: true }
 */
import { NextRequest, NextResponse } from "next/server";
import { getRepository, insertMemoryItems } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

interface RawMemoryItem {
  content: string;
  tags: string[];
}

interface RawBody {
  run_id: string;
  repository_id: string;
  items: RawMemoryItem[];
}

function isRawMemoryItem(v: unknown): v is RawMemoryItem {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.content === "string" &&
    o.content.trim().length > 0 &&
    Array.isArray(o.tags) &&
    (o.tags as unknown[]).every((t) => typeof t === "string")
  );
}

function isRawBody(v: unknown): v is RawBody {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.run_id === "string" &&
    typeof o.repository_id === "string" &&
    Array.isArray(o.items) &&
    (o.items as unknown[]).every(isRawMemoryItem)
  );
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

  const runTag = `run:${body.run_id}`;
  const itemsWithRunTag = body.items.map((item) => ({
    content: item.content,
    tags: item.tags.includes(runTag) ? item.tags : [...item.tags, runTag],
  }));

  try {
    await insertMemoryItems({
      workspaceId,
      source: "review",
      items: itemsWithRunTag,
    });
  } catch (err) {
    console.error("[ingest/memory-items] Postgres insert failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }

  return NextResponse.json({ ok: true }, { status: 202 });
}

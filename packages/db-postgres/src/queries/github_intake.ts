import { createHash } from "crypto";
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { queueEntries } from "../schema/queue_entries.js";

/**
 * Server-side GitHub issue intake — the webhook half of the Issue Queue.
 *
 * The runner model puts the queue on the backend, so admitting a GitHub issue is
 * a SERVER job: a delivered `issues` webhook lands here, we apply the same
 * input-contract gate the Python store uses (machine-checkable acceptance
 * criteria), resolve which workspace owns the repo, and persist a durable
 * `queue_entries` row. The already-built `/api/v1/runner/claim` then hands it to
 * the logged-in runner. This mirrors `agentrail/heartbeat/webhook.py` +
 * `agentrail/afk/input_contract.py` + `agentrail/afk/queue_store.py` so an issue
 * admitted by webhook is identical to one admitted by the Python path (same
 * deterministic row id → dedupe across both).
 */

// --- the input-contract gate (port of input_contract.validate) ---------------

// The `## Acceptance criteria` section, then a checkbox line inside it. Mirrors
// the Python regexes exactly so the two gates agree.
const AC_SECTION =
  /^#{1,6}\s*acceptance\s+criteria\b.*?\n([\s\S]*?)(?=^#{1,6}\s|$(?![\s\S]))/im;
const CHECKBOX = /^\s*[-*+]\s*\[[ xX]\]\s*(.+?)\s*$/gim;

export type AcGateResult =
  | { ok: true; criteria: string[] }
  | { ok: false; reason: string };

/**
 * Decide whether an issue body carries machine-checkable acceptance criteria.
 * Port of `input_contract.validate`: there must be an `Acceptance criteria`
 * section containing at least one markdown checkbox.
 */
export function validateAcceptanceCriteria(body: string): AcGateResult {
  const match = AC_SECTION.exec(body || "");
  if (!match) {
    return { ok: false, reason: "no 'Acceptance criteria' section in the issue body" };
  }
  const section = match[1] ?? "";
  const criteria: string[] = [];
  let m: RegExpExecArray | null;
  CHECKBOX.lastIndex = 0;
  while ((m = CHECKBOX.exec(section)) !== null) {
    const text = (m[1] ?? "").trim();
    if (text) criteria.push(text);
  }
  if (criteria.length === 0) {
    return {
      ok: false,
      reason:
        "Acceptance criteria are not machine-checkable: no checkbox criteria " +
        "the Objective Gate could turn into runnable checks",
    };
  }
  return { ok: true, criteria };
}

// --- deterministic row id (matches queue_store._entry_uuid) -------------------

// RFC 4122 URL namespace — the same one Python's uuid.NAMESPACE_URL uses.
const NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

/** uuid5(NAMESPACE_URL, name) — deterministic, so the same issue maps to one row. */
function uuid5Url(name: string): string {
  const ns = Buffer.from(NAMESPACE_URL.replace(/-/g, ""), "hex");
  const hash = createHash("sha1")
    .update(ns)
    .update(Buffer.from(name, "utf8"))
    .digest();
  const b = hash.subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5
  b[8] = (b[8]! & 0x3f) | 0x80; // variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** The durable row id for a (workspace, source, externalId), matching Python. */
function entryId(workspaceId: string, source: string, externalId: string): string {
  return uuid5Url(`agentrail-queue:${workspaceId}:${source}:${externalId}`);
}

// --- workspace resolution -----------------------------------------------------

/**
 * Find the workspace whose enabled GitHub connector lists `repoFullName`
 * (`owner/name`) in its `config.repos`. Returns null when no workspace owns it.
 */
export async function findWorkspaceByRepo(
  repoFullName: string
): Promise<string | null> {
  const rows = (await db.execute(sql`
    SELECT workspace_id
    FROM connectors
    WHERE provider = 'github'
      AND enabled = true
      AND config -> 'repos' @> ${JSON.stringify([repoFullName])}::jsonb
    LIMIT 1
  `)) as unknown as Array<{ workspace_id: string }>;
  const row = Array.from(rows)[0];
  return row ? row.workspace_id : null;
}

// --- enqueue ------------------------------------------------------------------

export type EnqueueResult =
  | { enqueued: true; id: string }
  | { enqueued: false; reason: string };

/**
 * Admit a GitHub issue into the durable queue. Runs the AC gate; on pass, inserts
 * a `queue_entries` row (tier 0, budget 2, state 'queued') with the deterministic
 * id so a re-delivery of the same issue dedupes (ON CONFLICT DO NOTHING).
 */
export async function enqueueGithubIssue(data: {
  workspaceId: string;
  repoFullName: string;
  number: number;
  title: string;
  body: string;
}): Promise<EnqueueResult> {
  const gate = validateAcceptanceCriteria(data.body);
  if (!gate.ok) return { enqueued: false, reason: gate.reason };

  const externalId = `${data.repoFullName}#${data.number}`;
  const id = entryId(data.workspaceId, "github", externalId);

  const inserted = await db
    .insert(queueEntries)
    .values({
      id,
      workspaceId: data.workspaceId,
      source: "github",
      externalId,
      title: data.title,
      body: data.body,
      tier: 0,
      remainingBudget: 2,
      state: "queued",
      blockedBy: [],
    })
    .onConflictDoNothing({ target: queueEntries.id })
    .returning({ id: queueEntries.id });

  if (inserted.length === 0) {
    return { enqueued: false, reason: "already queued (deduped)" };
  }
  return { enqueued: true, id };
}

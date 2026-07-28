// save_brief — Jace's autosave WRITE path into BRIEFS: the durable,
// server-side understanding of ONE product idea, keyed `(workspace_id,
// slug)` (design: docs/superpowers/specs/2026-07-28-jace-briefs-durable-idea-understanding-design.md;
// spec PR #1487; store slice PR #1489; route slice PR #1493).
//
// WHY THIS EXISTS: a real production grilling session (2026-07-27, "i want
// to add a blog our app") ran 9 turns and persisted nothing — grill-me's only
// write instruction was `CONTEXT.md`, impossible to write in the hosted
// deployment (`apps/jace/Dockerfile` installs no git, clones nothing). A
// phantom write is worse than no write — it reads as captured when nothing
// was kept. This tool is the durable home: call it PER TURN, as soon as
// something settles in a grilling conversation (an area gets pinned, the
// question in flight changes), not as a batch at the end — that per-turn
// autosave is what lets a grill session survive a context compaction, because
// the understanding is already externalized before the compaction happens.
//
// UNGATED, deliberately — unlike create_issue/create_workspace/create_repo.
// A brief lives only inside AgentRail's own console; nothing this writes
// reaches GitHub, a human's inbox, or any other outside system, and
// `create_issue` remains the only boundary crossing that still requires
// human approval. Every write here is also a per-item DELTA the console
// enforces its own invariants against (see below) — never a destructive
// full-replace, so there is nothing here for a human to approve before it
// happens the way there is for a real external side effect.
//
// SESSION RESOLUTION — same reasoning as fetch_briefs.ts (read that file's
// doc-comment for the full explanation): this wrapper resolves
// `ctx.session.parent?.rootSessionId ?? ctx.session.id`, not
// `ctx.session.id` alone. Most root tools read `ctx.session.id` directly
// because, for a plain root-tool call, that value already IS the top-level
// session the jace_sessions ledger anchors — but if this tool is ever
// invoked from inside a declared subagent's own child session, sending that
// CHILD session id 404s every call (the child id does not exist in
// jace_sessions — the exact failure the reviewer subagent's fetch_pr_diff.ts
// documents and guards against). The parent-chain fallback makes this tool
// correct in both cases without needing to know, at the call site, which one
// it is.
//
// THIS TOOL DOES NOT ACCEPT `status`. `draft`/`ready` is a HUMAN label
// toggled in the console; implementation-readiness is computed separately
// (`computeBriefReadiness`) precisely so "ready" can never become a flag the
// model sets on itself to unblock its own work. There is no `status`
// parameter in this tool's input schema at all — not "accepted and ignored",
// genuinely absent — and the console route itself 400s outright if a caller
// somehow sends one.
//
// TWO REFUSAL FIELDS THE CALLER MUST RELAY, NEVER SWALLOW — see the tool
// description below and lib/save_brief.core.mjs's module comment for the
// full reasoning; the short version: `skippedHumanAuthorityIds` means a
// human's own edit was left untouched (human edits win), and
// `skippedUnknownResolvedIds` means an item can't resolve while its `kind`
// is still `unknown` (answer it or mark it out-of-scope first). Both arrays
// are always present in a successful result, even when empty, and the
// `rendered` field spells out any non-empty one in plain language — but the
// STRUCTURED fields are also there because a caller must reason about them,
// not just read prose past them.
//
// Least privilege by construction:
//  - The network reach is exactly one endpoint via the global `fetch`. It
//    does NOT import node:child_process; the model cannot use it to reach an
//    arbitrary URL — the host/path come from configured env, never from
//    model input.
//  - On unset config, an unreachable/failing console, or an erroring console
//    it returns a DEGRADED result (never throws, never retries — retrying a
//    partially-applied write blind risks double-writing items), so a fetch
//    problem can never crash the turn.
//  - Free-text fields (`statement`, `evidence`, `openQuestion`) are run
//    through `hardenUntrusted` before they ever leave this module, and the
//    console applies its own secret scan server-side on write — a 422
//    means the console detected something credential-shaped and refused the
//    ENTIRE batch; relay that to the human, never retry unchanged.

import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  saveBrief,
  BRIEF_AREAS,
  BRIEF_ITEM_KINDS,
  BRIEF_ITEM_STATES,
  BRIEF_ITEM_RESOLUTIONS,
} from "../lib/save_brief.core.mjs";

// A wedged/unresponsive console must not hang the chat turn for minutes
// (mirrors create_workspace.ts's own fix for this) — an AbortController aborts
// the in-flight request after TIMEOUT_MS, so a hung console can never hang
// this tool call indefinitely. The resulting AbortError throw already maps to
// degraded("unreachable") in saveBrief's try/catch.
const TIMEOUT_MS = 10_000;

// The REAL transport: one POST via the global fetch, narrowed to the
// { status, json } shape the core expects. Injected exactly as
// create_workspace/post_pr_review inject their real drivers, so the core
// stays hermetic in tests.
async function realTransport(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
): Promise<{ status: number; json: () => Promise<unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return { status: res.status, json: () => res.json() };
  } finally {
    clearTimeout(timer);
  }
}

const areaSchema = z.enum(BRIEF_AREAS as unknown as [string, ...string[]]);
const kindSchema = z.enum(BRIEF_ITEM_KINDS as unknown as [string, ...string[]]);
const stateSchema = z.enum(BRIEF_ITEM_STATES as unknown as [string, ...string[]]);
const resolutionSchema = z.enum(BRIEF_ITEM_RESOLUTIONS as unknown as [string, ...string[]]);

const itemSchema = z.object({
  id: z
    .string()
    .optional()
    .describe(
      "Omit to INSERT a new item. Supply an existing item's `id` (from a prior fetch_briefs/save_brief " +
        "result) to update it in place — sending the same area/statement without an id creates a DUPLICATE " +
        "item instead of editing the original.",
    ),
  area: areaSchema.describe(
    "Which of grill-me's six coverage areas this item settles: problem, users, constraints, scope, or success-signal.",
  ),
  statement: z.string().min(1).describe("The requirement, normalized to a clear statement."),
  evidence: z
    .string()
    .optional()
    .describe(
      "The user's OWN WORDS that settled this, verbatim — not a paraphrase. This is what lets the brief " +
        "carry the *why*, not just the *what*, across a context compaction; a normalized statement alone " +
        "loses the nuance that a paraphrase would flatten.",
    ),
  kind: kindSchema.describe(
    "How firm this is: 'required' or 'optional' once answered, 'unknown' while still open, " +
      "'out-of-scope' if the human explicitly ruled it out. An 'unknown' item can NEVER be saved with " +
      "state: 'resolved' (any resolution, or none) — the console rejects that combination outright. " +
      "Answer it first (kind -> required/optional) or mark it out-of-scope, then resolve it in a follow-up call.",
  ),
  state: stateSchema
    .optional()
    .describe(
      "'open' (default, omit to leave as-is on an existing item) or 'resolved' once it's settled for the " +
        "CURRENT phase. Omitting this on an update leaves the item's stored state untouched — it is not reset.",
    ),
  resolution: resolutionSchema
    .nullable()
    .optional()
    .describe(
      "Set only alongside state: 'resolved' — 'implemented', 'deferred' (seeds the next phase; the item " +
        "stays as known future work), 'rejected', or 'satisfied-elsewhere'. Omit (not null) to leave an " +
        "existing item's resolution untouched.",
    ),
});

export default defineTool({
  description:
    "Autosave a DELTA of one brief — the durable, server-side understanding " +
    "of ONE product idea. Call this PER TURN as soon as something settles in " +
    "a grilling conversation (never batch it up for the end): an area gets " +
    "pinned, the in-flight question changes, or a human answer resolves an " +
    "item. This is what lets the conversation survive a context compaction " +
    "— the understanding is externalized before the compaction happens, " +
    "unlike the old grill-me flow, which wrote to `CONTEXT.md` (impossible " +
    "in this hosted deployment — no git checkout exists) and lost " +
    "everything the moment a session ended. `slug` is the brief's stable " +
    "identity: reuse an EXISTING slug (from fetch_briefs) to continue that " +
    "idea's understanding rather than forking a duplicate brief for the " +
    "same thing — e.g. adding auth to a shipped blog reopens the blog's " +
    "brief, it does not start a new one. `title`/`openQuestion`/`grounding` " +
    "are omittable on any call that only touches items — omitting them " +
    "leaves the existing value UNCHANGED, it does not clear it; `title` is " +
    "required only the FIRST time a slug is used (creating the brief). " +
    "`items` is a PATCH: each item with an `id` updates that exact row " +
    "(any field you omit on it — evidence/state/resolution — is left " +
    "exactly as stored, not reset), each item without an `id` inserts a new " +
    "row; every OTHER item already on the brief is left untouched. " +
    "\n\n" +
    "DOES NOT ACCEPT `status` — there is no such parameter. `draft`/`ready` " +
    "is a HUMAN-ONLY label toggled in the console; whether a brief is ready " +
    "for `to-issues` is computed from its items, specifically so the model " +
    "can never flag its own work 'ready' to unblock itself. Do not try to " +
    "set it, and do not describe a brief as 'ready' to the user — that " +
    "word is the human's call to make in the console." +
    "\n\n" +
    "TWO FIELDS ON THE RESULT ARE REFUSALS, NOT DETAILS — YOU MUST RELAY " +
    "THEM, NEVER STAY SILENT ON THEM: `skippedHumanAuthorityIds` lists " +
    "items that were NOT updated because a human already edited them in " +
    "the console (human edits are locked and win, always) — if you asked " +
    "for one of these to change and it's in this list, tell the user the " +
    "human's version was kept, do not claim you updated it. " +
    "`skippedUnknownResolvedIds` lists items that were NOT saved as " +
    "resolved because their `kind` is still 'unknown' — an unknown is not " +
    "a requirement yet, so there was nothing to resolve; answer it (kind " +
    "-> required/optional) or mark it out-of-scope, then resolve it in a " +
    "follow-up call. Silently treating either list as empty when it isn't " +
    "means telling a human something was recorded when it was not — the " +
    "exact failure this tool exists to prevent." +
    "\n\n" +
    "Never throws. Returns a degraded result when the console is " +
    "unconfigured, unreachable, or rejects the write (e.g. 422 when a " +
    "value looks like a pasted credential — never retry that unchanged; " +
    "tell the human instead). No approval gate: this only ever touches " +
    "AgentRail's own brief store, never GitHub or any other outside " +
    "system — `create_issue` remains the only boundary crossing that " +
    "needs a human's approval.",
  inputSchema: z.object({
    slug: z
      .string()
      .min(1)
      .describe(
        "Stable identity for this idea, kebab-case (e.g. 'blog'). Reuse an existing brief's slug (from " +
          "fetch_briefs) to continue it; propose a short new one only for a genuinely new idea.",
      ),
    title: z
      .string()
      .optional()
      .describe(
        "Human-readable title. Required the FIRST time this slug is used (creating the brief); omit on a " +
          "later call to leave the existing title unchanged.",
      ),
    openQuestion: z
      .string()
      .optional()
      .describe(
        "The question in flight right now, so a resumed conversation opens with it instead of starting " +
          "over. Omit to leave the existing value unchanged; pass '' explicitly to clear it once nothing is open.",
      ),
    grounding: z
      .object({
        wikiPageSlugs: z.array(z.string()).optional().describe("Wiki page slugs read while settling this brief."),
        memoryItemIds: z.array(z.string()).optional().describe("Workspace-memory item ids read while settling this brief."),
        commitSha: z
          .string()
          .nullable()
          .optional()
          .describe("The wiki's commit stamp at the time those pages were read, for staleness comparison on resume."),
      })
      .optional()
      .describe(
        "What repo/memory context grounded this brief, so a later resume can detect the wiki has since " +
          "moved and re-ground before proposing anything. Omit if nothing changed since the last save.",
      ),
    items: z
      .array(itemSchema)
      .optional()
      .describe("A DELTA of items to insert/update — only the ones that changed this turn, never the whole set."),
  }),
  async execute(input, ctx) {
    const eveSessionId = ctx?.session?.parent?.rootSessionId ?? ctx?.session?.id;
    return saveBrief({
      eveSessionId,
      slug: input.slug,
      title: input.title,
      openQuestion: input.openQuestion,
      grounding: input.grounding,
      items: input.items,
      env: process.env,
      transport: realTransport,
    });
  },
});

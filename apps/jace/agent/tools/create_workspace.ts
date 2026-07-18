// create_workspace — Jace's other GATED write action on the outside world,
// alongside create_issue: creates a REAL AgentRail workspace from a
// conversation (spec §4.2, issue #1264). The workspace is bound to THIS
// conversation's own chat identity immediately, either fully owned (when the
// identity already has a linked GitHub-bound user) or "owner-elect" (bound
// only, ownership completing once the identity finishes a GitHub connect —
// see send_connect_link and createWorkspaceOwnerElect's doc-comment in
// @agentrail/db-postgres for what that means and who completes it, issue
// #1264 PR ②).
//
// `approval: always()` — the SAME gate class as create_issue, not
// send_connect_link's narrower ungated exception: unlike send_connect_link
// (which only ever overwrites this same conversation's own link-token slot),
// this tool creates real, durable product state — a workspace that shows up
// on the console and that other tools (create_issue) can act against. See
// apps/jace/test/no-second-write-path.test.mjs for the enumerated set of
// gated tools this invariant is checked against; every invocation pauses for
// a human approve/reject before it runs.
//
// The model supplies only `name` — the human approves the EXACT name before
// this runs. Everything else this resolves to (which conversation, which
// chat identity) is derived server-side from `ctx.session.id`, Eve's own
// session id for the conversation actually invoking this tool call, never
// model-supplied (see annex-eve-internals.md / connect-link/route.ts's
// doc-comment for the pattern this mirrors, and
// agent/lib/create_workspace.core.mjs's module comment for the full
// resolution + failure-handling contract).

import { defineTool } from "eve/tools";
import { z } from "zod";
import { always } from "eve/tools/approval";
import { runCreateWorkspace } from "../lib/create_workspace.core.mjs";

// Stdlib `fetch` with a timeout — mirrors send_connect_link.ts's own
// `realTransport` idiom (itself mirroring the console's established
// `fetchWithTimeout`, apps/console/app/api/v1/workspaces/[workspaceId]/
// connectors/secret/telegram.ts): an AbortController aborts the in-flight
// request after TIMEOUT_MS, so a hung console can never hang this tool call
// (and therefore the conversation turn) indefinitely.
const TIMEOUT_MS = 8000;

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

export default defineTool({
  description:
    "Create a real AgentRail workspace for THIS conversation. Call this " +
    "when the user wants Jace set up and no workspace exists for this " +
    "conversation yet — AFTER confirming the exact name with them, since " +
    "this is human-approved before it runs. The workspace is bound to this " +
    "conversation's own chat identity immediately; full console ownership " +
    "completes once the user connects GitHub (offer send_connect_link " +
    "next). On success returns { workspaceId, name, url } — relay the url " +
    "so the user can see the workspace on the console. On failure returns " +
    "a short honest message (e.g. this conversation already has a " +
    "workspace) — relay it verbatim rather than inventing your own " +
    "explanation or retrying silently.",
  // Always require a human approve/reject before this tool executes — same
  // gate class as create_issue (see the file-level comment above).
  approval: always(),
  inputSchema: z.object({
    name: z
      .string()
      .min(1)
      .max(80)
      .describe("The workspace name, confirmed with the user before calling."),
  }),
  async execute(input, ctx) {
    return runCreateWorkspace({
      eveSessionId: ctx.session.id,
      name: input.name,
      env: process.env,
      transport: realTransport,
    });
  },
});

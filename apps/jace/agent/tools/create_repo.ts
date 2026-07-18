// create_repo — Jace's THIRD and, for now, LAST gated write action on the
// outside world, alongside create_issue and create_workspace: creates a REAL
// repository on the workspace's own GitHub account, then runs the full
// connect chain (repository row + connector self-configure + webhook +
// onboard enqueue — see apps/console/app/api/v1/runner/repos/route.ts's
// doc-comment for the authoritative account of that chain, issue #1265 PR
// ①, spec §4.2).
//
// `approval: always()` — the SAME gate class as create_issue and
// create_workspace: this creates real, durable, EXTERNAL product state (a
// GitHub repo under the user's own account, wired into this workspace), not
// a read and not a narrowly self-scoped write like send_connect_link. See
// apps/jace/test/no-second-write-path.test.mjs for the enumerated set of
// gated tools this invariant is checked against; every invocation pauses for
// a human approve/reject before it runs.
//
// The model supplies `name` and, optionally, `private` — the human approves
// the EXACT call (name + visibility) before this runs. Everything else this
// resolves to (which conversation, which workspace, which GitHub token) is
// derived server-side from `ctx.session.id`, Eve's own session id for the
// conversation actually invoking this tool call, never model-supplied (see
// annex-eve-internals.md / connect-link/route.ts's doc-comment for the
// pattern this mirrors, and agent/lib/create_repo.core.mjs's module comment
// for the full resolution + failure-handling contract).
//
// The description below documents intent for CODE readers, not a promise
// about what the approving human sees: Eve's stock HITL renders only
// "Approve tool call: create_repo" + Yes/No on Telegram (no input, no
// description at all), and adds just the raw input JSON on Slack — neither
// surface renders this description. Until #1273 enriches approval
// rendering, the LIVE safety mechanism is the mandated pre-call confirmation
// in chat (instructions.md: confirm the exact name first).

import { defineTool } from "eve/tools";
import { z } from "zod";
import { always } from "eve/tools/approval";
import { runCreateRepo } from "../lib/create_repo.core.mjs";

// Stdlib `fetch` with a timeout — mirrors create_workspace.ts's own
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
    "Create a repository with the given name on the user's GitHub account " +
    "(private by default), connect it to this workspace, and set up its " +
    "webhook. Call this when the user wants Jace to build something and no " +
    "repo is connected to this workspace yet — AFTER confirming the exact " +
    "name (and, if they care, whether it should be public) with them, since " +
    "this is human-approved before it runs. On success returns { url, " +
    "fullName, private, webhookCreated, onboardQueued } — relay the url so " +
    "the user can see the repo, and be honest about webhookCreated: if " +
    "false, tell them the webhook could not be created and to connect it " +
    "from the console, rather than implying it worked; mention " +
    "onboardQueued only when it's true. On failure returns a short, " +
    "honest, ready-to-relay message — e.g. a taken name already comes with " +
    "a nudge to pick another — relay it verbatim rather than inventing " +
    "your own explanation or retrying silently.",
  // Always require a human approve/reject before this tool executes — same
  // gate class as create_issue and create_workspace (see the file-level
  // comment above).
  approval: always(),
  inputSchema: z.object({
    name: z
      .string()
      .min(1)
      .max(100)
      .describe(
        "The repo name, confirmed with the user before calling. GitHub only " +
          "allows letters, numbers, '.', '_', and '-' — propose a name using " +
          "only those characters.",
      ),
    private: z
      .boolean()
      .optional()
      .describe(
        "Repo visibility. Omit to default to private — only set this to " +
          "false if the user explicitly wants a public repo.",
      ),
  }),
  async execute(input, ctx) {
    return runCreateRepo({
      eveSessionId: ctx.session.id,
      name: input.name,
      private: input.private,
      env: process.env,
      transport: realTransport,
    });
  },
});

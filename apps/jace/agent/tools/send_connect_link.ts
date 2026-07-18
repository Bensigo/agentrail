// send_connect_link — mints a one-time connect-GitHub link for THIS
// conversation's own chat identity (issue #1263 PR ②) and hands it back so
// Jace can put the URL directly in its reply. Being in-thread IS the
// compensating control here: there is no separate "send" step this tool
// performs — the tool only mints, the model relays.
//
// This is Jace's other write action on the outside world, alongside
// create_issue, but a much narrower one: it never touches the factory,
// GitHub, or any workspace — it only overwrites THIS SAME conversation's own
// chat_identities.link_token / link_token_expires_at with a fresh single-use
// token, scoped server-side to the caller. That narrow blast radius (a
// stray, harmless re-mint for the identity already talking to Jace right
// now, never a cross-tenant or factory-facing action) is why this carries NO
// `approval` gate, unlike the console-gated write tools (create_issue etc.).
//
// It takes NO input from the model — inputSchema is an empty object. The
// identifying value is `ctx.session.id`, Eve's own session id for the
// conversation currently running this tool call, read straight off
// ToolContext (see annex-eve-internals.md) rather than any model-supplied
// argument. The console resolves THAT session id, server-side, all the way
// down to a chat identity (jace_sessions.eve_session_id -> chat_identity_id);
// see connect-link/route.ts's doc-comment for why this replaces the old
// caller-chosen (platform, platformUserId) shape and what accepted residual
// it closes.

import { defineTool } from "eve/tools";
import { z } from "zod";
import { sendConnectLink } from "../lib/send_connect_link.core.mjs";

// Stdlib `fetch` with a timeout — mirrors the console's own established
// `fetchWithTimeout` idiom (apps/console/app/api/v1/workspaces/[workspaceId]/
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
    "Mint a one-time connect-GitHub link for THIS conversation's sender and " +
    "return it so you can put the URL directly in your reply — that IS the " +
    "send, there is no separate step. Call this when work needs the user's " +
    "own GitHub (creating an issue, reading a private repo) and they are " +
    "not connected yet. Takes no input; the conversation is resolved " +
    "server-side. On success returns { url, expiresAt }. On failure returns " +
    "a short honest message — tell the user to try again rather than " +
    "failing silently or inventing a link. Writes nothing but a fresh " +
    "single-use token for this same conversation's own chat identity; needs " +
    "no approval.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    return sendConnectLink({
      eveSessionId: ctx.session.id,
      env: process.env,
      transport: realTransport,
    });
  },
});

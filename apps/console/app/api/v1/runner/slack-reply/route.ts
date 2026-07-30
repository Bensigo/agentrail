import { NextRequest, NextResponse } from "next/server";
import { getSlackInstallation } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";
import { sendSlackChannelMessage } from "../../../../../lib/slack-bot";

const MAX_TEXT_LENGTH = 8000;

/**
 * POST /api/v1/runner/slack-reply   { teamId, channelId, threadTs?, text }
 *
 * Task 4 (docs/superpowers/specs/2026-07-29-slack-multi-workspace-design.md
 * §4) — THE ROUTE THIS WHOLE DESIGN EXISTS FOR. jace stopped posting to
 * Slack itself (see `apps/jace/agent/channels/slack.ts`'s header comment for
 * why eve's own per-turn `botToken` thunk and its Slack channel state cannot
 * safely carry a per-workspace credential here); every completed Slack reply
 * now arrives here instead, and THIS is the one place that picks a Slack
 * bot token to post with.
 *
 * THE TEAM ID IS EVERYTHING: it travels explicitly, as a plain value, all
 * the way from the inbound webhook (`connectors/slack/events/route.ts`)
 * through `channel-dispatch.ts`'s `auth.attributes` to eve's session, and
 * back out here on this call — never inferred from `channelId`, never read
 * from any ambient/default state. `getSlackInstallation(teamId)` is the
 * ONLY place a token is chosen, and it fails CLOSED: a missing `teamId`, or
 * one with no active installation (never installed, uninstalled, or
 * revoked — the query layer collapses all three to `null`), means NOTHING
 * is posted, ever — not a fallback to some other team's token, not a guess.
 * A mistake here is the one way this design could leak team A's reply into
 * team B's Slack; every failure path below is loud (a non-2xx response +a
 * server-side log line naming the reason) rather than silent.
 *
 * AUTH: the shared `JACE_CONSOLE_TOKEN` secret via `requireJaceConsoleSecret`
 * — the same central-secret seam `runner/chat-reply` and
 * `runner/discord-inbound` already use for the Jace<->console seam.
 *
 * SECRET SAFETY: the resolved bot token never appears in a log line, an
 * error message, or this route's response body — see `sendSlackChannelMessage`
 * (`lib/slack-bot.ts`)'s own error strings, which are already token-free.
 *
 * 400 — malformed body (missing teamId/channelId/text, or text too long).
 * 401 — bad/missing secret. 404 — no active installation for `teamId`.
 * 502 — Slack itself rejected the send or was unreachable. 200 — `{ ok: true }`.
 */
export async function POST(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) {
    return authError;
  }

  const body = (await request.json().catch(() => null)) as
    | { teamId?: unknown; channelId?: unknown; threadTs?: unknown; text?: unknown }
    | null;

  const teamId = typeof body?.teamId === "string" ? body.teamId.trim() : "";
  const channelId = typeof body?.channelId === "string" ? body.channelId.trim() : "";
  const threadTs = typeof body?.threadTs === "string" ? body.threadTs.trim() : "";
  const text = typeof body?.text === "string" ? body.text.trim() : "";

  // FAIL LOUD, NEVER GUESS: a reply call with no team id is rejected
  // outright — there is no safe default token to fall back to.
  if (!teamId) {
    console.warn("[runner/slack-reply] rejected: request carries no teamId — refusing to guess a token.");
    return NextResponse.json({ error: "teamId is required" }, { status: 400 });
  }
  if (!channelId) {
    return NextResponse.json({ error: "channelId is required" }, { status: 400 });
  }
  if (!text) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return NextResponse.json({ error: `text exceeds ${MAX_TEXT_LENGTH} characters` }, { status: 400 });
  }

  // THE ONE TOKEN-CHOOSING STEP. `getSlackInstallation` collapses "never
  // installed", "uninstalled", and "revoked" to the same `null` — this
  // route does not need to (and must not) distinguish them: none of the
  // three has a safe token to post with.
  const installation = await getSlackInstallation(teamId);
  if (!installation) {
    console.warn(
      `[runner/slack-reply] rejected: no active Slack installation for team ${teamId} — ` +
        "never installed, uninstalled, or revoked; nothing posted."
    );
    return NextResponse.json({ error: "No active Slack installation for this team" }, { status: 404 });
  }

  const result = await sendSlackChannelMessage(
    installation.botToken,
    channelId,
    text,
    threadTs ? threadTs : undefined
  );

  if (!result.ok) {
    // `result.error` is already token-free (see sendSlackChannelMessage's
    // own doc-comment) — safe to log and to return in the response body.
    console.error(`[runner/slack-reply] Slack send failed for team ${teamId}:`, result.error);
    return NextResponse.json({ error: result.error }, { status: 502 });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}

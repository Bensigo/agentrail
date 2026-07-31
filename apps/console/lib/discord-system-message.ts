/**
 * Console-side Discord SYSTEM sends (#1284, mirroring #1262 PR ②'s
 * `telegram-system-message.ts`) — messages the dispatcher
 * (`channel-dispatch.ts`) posts directly, model-free: the multi-workspace
 * "which one is this about?" ask and its pin confirmation (same spec §4.2
 * flow Telegram already has). These are NOT model turns — Eve never sees
 * them — so they go straight to the Discord Bot API via
 * `sendDiscordChannelMessage`, distinctly from the Eve-turn path that replies
 * through Jace's own native discord channel.
 *
 * Resolves its OWN token from `DISCORD_BOT_TOKEN` — the shared hosted bot has
 * exactly one token, console-wide (deploy/.env.production.example, next to
 * `DISCORD_PUBLIC_KEY`) — matching the Telegram system-message module's
 * convention exactly.
 */
import { sendDiscordChannelMessage, type SendResult } from "./discord-bot";

/**
 * Post a system (non-model) message to `channelId` via the shared hosted
 * bot. Returns a typed failure — never throws — when `DISCORD_BOT_TOKEN` is
 * unset or the send itself fails.
 */
export async function sendSystemDiscordMessage(
  channelId: string,
  text: string
): Promise<SendResult> {
  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) {
    return { ok: false, error: "DISCORD_BOT_TOKEN is not configured." };
  }
  return sendDiscordChannelMessage(token, channelId, text);
}

const DISCORD_API_BASE = "https://discord.com/api/v10";

/**
 * Timeout for the followup webhook attempt, matching `discord-bot.ts`'s own
 * (module-private, not exported — so duplicated here rather than imported)
 * `TIMEOUT_MS` convention for every other outbound Discord call in this
 * codebase.
 *
 * Why a timeout is mandatory here specifically: `channel-dispatch.ts`'s
 * `drainQueue` processes inbound rows one at a time in a SINGLE shared
 * serial loop across EVERY channel and workspace. `fetch` has no default
 * timeout of its own (undici's own defaults are minutes-scale, and this
 * codebase configures no custom dispatcher) — an unbounded followup call
 * would stall every other team's inbound processing for as long as that
 * default takes to give up, not just this one send.
 */
const FOLLOWUP_TIMEOUT_MS = 8000;

/**
 * Log a followup-attempt failure right before falling back to the bot path.
 *
 * SECRET SAFETY: logs ONLY the numeric HTTP status, or `null` when the
 * attempt threw before any response existed at all (a network failure, or
 * the `FOLLOWUP_TIMEOUT_MS` abort above surfacing as a `TimeoutError`
 * `DOMException`) — NEVER the followup URL (which embeds the interaction
 * token as a path segment) and never a response body. Mirrors
 * `discord-followup.core.mjs`'s own `extractDiscordErrorCode` doc-comment:
 * the original production bug this whole function exists to fix was
 * invisible precisely because this path used to be a silent `catch {}`, and
 * Discord's own error bodies can echo back submitted content.
 */
function logFollowupFallback(status: number | null): void {
  console.error(
    `[discord-system-message] followup failed, falling back to bot post (status ${status})`
  );
}

/**
 * Post a system (non-model) message to `channelId`, preferring the Discord
 * interaction-followup webhook over the shared bot when a followup
 * credential is present — delivery trap #1 from the subscription-platform
 * spec (`docs/superpowers/specs/2026-07-29-subscription-platform-design.md`
 * §6): the plain bot-post path above (`sendSystemDiscordMessage`) requires
 * the shared hosted bot to have View Channel + Send Messages on the target
 * channel, so a private channel with a restrictive permission overwrite
 * rejects it with `50001 Missing Access` — SILENTLY dropping the system
 * prompt (the caller logs that typed failure; this function does not).
 *
 * This is the console-side mirror of
 * `apps/jace/agent/lib/discord-followup.core.mjs`'s `deliverDiscordBubble`
 * (read for semantics only — that module is outside this workspace and is
 * never imported here). Deliberately minimal relative to that reference:
 * this sender only ever carries a short system prompt (never a model reply
 * that could cross Discord's 2000-char limit), so there is no chunking and
 * no `allowed_mentions` handling here — a single `POST` with `{ content }`.
 *
 * The interaction-followup webhook
 * (`POST /webhooks/{application_id}/{interaction_token}`) needs no channel
 * permission and no `Authorization` header at all — the token itself IS the
 * credential, valid for 15 minutes past the original interaction.
 *
 * `interactionToken`/`applicationId` travel together or not at all — the
 * same both-or-neither rule `channel-dispatch.ts`'s `buildDoorInitiatorAuth`
 * already applies when writing them into `auth.attributes` in the first
 * place (channel-dispatch.ts:788-791). Either one blank/missing is treated
 * exactly like no credential at all: straight to the bot path below.
 *
 * Falls through to `sendSystemDiscordMessage` (unmodified) on ANY of: a
 * missing/partial credential, a non-2xx followup response, or the followup
 * `fetch` itself throwing (including a `FOLLOWUP_TIMEOUT_MS` abort) — so
 * callers keep today's behavior (public channels keep working; private
 * channels get the 50001-shaped typed failure they already log) whenever the
 * followup path isn't available or doesn't pan out. Never throws.
 *
 * Every followup-attempt failure logs first (`logFollowupFallback`, sanitized
 * — status only, never the token/URL/body) before falling back, and the
 * attempt itself is bounded by `FOLLOWUP_TIMEOUT_MS` — both load-bearing
 * because this function is awaited inside `channel-dispatch.ts`'s single
 * shared serial drain loop (see `FOLLOWUP_TIMEOUT_MS`'s own doc-comment).
 */
export async function sendSystemDiscordMessagePreferFollowup(params: {
  channelId: string;
  text: string;
  interactionToken?: string;
  applicationId?: string;
}): Promise<SendResult> {
  const { channelId, text, interactionToken, applicationId } = params;

  const hasFollowupCredentials =
    typeof interactionToken === "string" &&
    interactionToken.trim() !== "" &&
    typeof applicationId === "string" &&
    applicationId.trim() !== "";

  if (hasFollowupCredentials) {
    try {
      const res = await fetch(
        `${DISCORD_API_BASE}/webhooks/${applicationId}/${interactionToken}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: text }),
          signal: AbortSignal.timeout(FOLLOWUP_TIMEOUT_MS),
        }
      );
      if (res.ok) {
        return { ok: true };
      }
      logFollowupFallback(res.status);
    } catch {
      // Network-level failure OR a FOLLOWUP_TIMEOUT_MS abort (surfaces as a
      // "TimeoutError" DOMException) on the followup attempt — either way,
      // no HTTP response ever existed to log a status from. Falls through to
      // the bot path below, same as a non-2xx response.
      logFollowupFallback(null);
    }
  }

  return sendSystemDiscordMessage(channelId, text);
}

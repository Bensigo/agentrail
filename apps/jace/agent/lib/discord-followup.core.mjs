// Pure, dependency-free core for Jace's Discord reply delivery (prod bug fix
// — root cause diagnosed 2026-07-25, see .superpowers/sdd/discord-followup/).
//
// Jace's reply used to ALWAYS post as a separate message through the Discord
// Bot API (`channel.discord.post()` -> `POST /channels/{id}/messages`), which
// requires the shared hosted bot to have View Channel + Send Messages on
// that specific channel. A private channel with a restrictive permission
// overwrite (or a user-install where the bot isn't in the guild at all)
// rejects that post with `50001 Missing Access` — silently, because the
// user's own slash-command invocation is authorized by the USER's
// permissions, not the bot's, so the command still appears to work.
//
// Discord's own intended mechanism for replying to an interaction is the
// FOLLOWUP WEBHOOK: `POST /webhooks/{application_id}/{interaction_token}`.
// It needs NO auth header (the token IS the credential) and NO channel
// permission, and is valid for 15 minutes after the interaction. This module
// is the pure decision/URL-building logic for using it, with a mandatory
// fallback to the existing bot-post path — so a private channel gets fixed
// and every case that already works today keeps working unchanged.
//
// Both network calls (the followup POST and the bot-post fallback) are
// injected, so this is unit-testable without a live Eve session or a real
// Discord API — mirrors console_chat_reply.core.mjs's `transport` seam and
// imessage.ts's `buildImessageHandle` split (network in the `.ts` wrapper,
// decision logic here). Lives under agent/lib/, which Eve does not load as a
// tool/channel.
//
// SECRET HANDLING: `interactionToken` is a short-lived credential. This
// module never logs it (the followup failure path below is a silent
// fall-through, not a console.error) and never embeds it in a thrown Error
// message — the only thrown errors here are re-throws of whatever
// `postViaBot` itself throws, which callers already do not construct from
// the token (see agent/channels/discord.ts).

/** Discord's REST API base (v10). */
export const DISCORD_API_BASE = "https://discord.com/api/v10";

/**
 * Build the documented interaction-followup webhook URL. No auth header is
 * ever needed for this endpoint — the token IS the credential.
 *
 * @param {{ applicationId: string, interactionToken: string }} args
 * @returns {string}
 */
export function buildFollowupUrl({ applicationId, interactionToken }) {
  return `${DISCORD_API_BASE}/webhooks/${applicationId}/${interactionToken}`;
}

/**
 * Pull a followup-eligible `{ applicationId, interactionToken }` pair out of
 * an arbitrary session-auth `attributes` object. eve forwards the `auth`
 * object passed to `args.receive(discord, { auth, ... })` UNCHANGED into
 * `ctx.session.auth.initiator.attributes` (verified against eve@0.19.0's own
 * `SessionAuthContext`/`SessionContext` type declarations — the proactive
 * `DiscordReceiveTarget` shape has no room for either field, so this is the
 * ONLY seam that reliably carries them from
 * apps/console/lib/channel-dispatch.ts's `buildDoorInitiatorAuth` through to
 * this channel's `message.completed` handler).
 *
 * Both fields must be present and non-blank strings — a partial pair cannot
 * build a valid URL, so it is treated the same as "no credential at all".
 * Returns `null` rather than throwing: a missing/malformed shape means "fall
 * back to the bot post", never an error.
 *
 * @param {Record<string, unknown> | null | undefined} attributes
 * @returns {{ applicationId: string, interactionToken: string } | null}
 */
export function extractFollowupCredentials(attributes) {
  if (!attributes || typeof attributes !== "object") return null;
  const applicationId = attributes.applicationId;
  const interactionToken = attributes.interactionToken;
  if (
    typeof applicationId !== "string" ||
    applicationId.trim() === "" ||
    typeof interactionToken !== "string" ||
    interactionToken.trim() === ""
  ) {
    return null;
  }
  return { applicationId, interactionToken };
}

/**
 * Whether a followup transport response counts as delivered — any 2xx
 * status. Anything else (404/401 for an expired or already-used token, a
 * malformed/missing status) is NOT success and triggers the bot-post
 * fallback.
 *
 * @param {unknown} status
 * @returns {boolean}
 */
export function isFollowupSuccess(status) {
  return typeof status === "number" && status >= 200 && status < 300;
}

/**
 * Deliver one reply bubble: the interaction followup webhook when a valid
 * credential is available AND the attempt succeeds, else the existing
 * bot-authenticated channel post.
 *
 * The followup attempt NEVER throws out of this function — a missing
 * credential, a non-2xx response, or a transport-level network error (the
 * `postFollowup` call itself throwing) all silently fall back to
 * `postViaBot`. This is what protects every conversation that works today
 * (no interaction token available, or the bot genuinely does have channel
 * permission): behavior for those is unchanged. If `postViaBot` itself
 * throws — followup unavailable/failed AND the bot post also fails — that
 * error propagates unguarded, exactly matching today's behavior for a
 * channel with no interaction token at all.
 *
 * @param {{
 *   content: string,
 *   attributes?: Record<string, unknown> | null,
 *   postFollowup: (url: string, init: { method: string, headers: Record<string,string>, body: string }) => Promise<{ status: number }>,
 *   postViaBot: () => Promise<unknown>,
 * }} args
 * @returns {Promise<{ delivered: "followup" | "bot" }>}
 */
export async function deliverDiscordBubble({ content, attributes, postFollowup, postViaBot }) {
  const credentials = extractFollowupCredentials(attributes);
  if (credentials) {
    try {
      const res = await postFollowup(buildFollowupUrl(credentials), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (isFollowupSuccess(res?.status)) {
        return { delivered: "followup" };
      }
    } catch {
      // Network-level failure on the followup attempt (e.g. the shared bot
      // process can't reach discord.com) — fall through to the bot-post
      // fallback below. Deliberately silent: a failed followup is an
      // expected, recoverable outcome (an expired 15-minute window, or no
      // token at all), not something to log.
    }
  }
  await postViaBot();
  return { delivered: "bot" };
}

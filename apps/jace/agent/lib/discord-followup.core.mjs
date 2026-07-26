// Pure, dependency-free core for Jace's Discord reply delivery (prod bug fix
// — root cause diagnosed 2026-07-25, see .superpowers/sdd/discord-followup/;
// hardened 2026-07-26 against a follow-up adversarial review — same doc dir,
// fix-1-brief.md — see each function's own doc comment for which finding it
// addresses).
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
// and every case that already works today keeps working unchanged. It also
// matches `channel.discord.post()`'s own behavior in two ways eve's runtime
// applies that this path used to skip (verified against eve@0.19.0's REAL
// compiled runtime, apps/jace/.output/server/_libs/eve.mjs — not just its
// `.d.ts` stubs, which is how the `current`-vs-`initiator` gap below slipped
// through the first time): every followup POST suppresses mentions
// (`allowed_mentions: {parse:[]}`, matching eve's own `normalizeMessageBody`
// default — see `DISCORD_NO_MENTIONS`) and chunks any bubble over 2000 chars
// into multiple in-order followup POSTs, using the same limit and
// break-preference algorithm as eve's own `splitDiscordMessageContent` (see
// `chunkDiscordContent`).
//
// Both network calls (the followup POST and the bot-post fallback) are
// injected, so this is unit-testable without a live Eve session or a real
// Discord API — mirrors console_chat_reply.core.mjs's `transport` seam and
// imessage.ts's `buildImessageHandle` split (network in the `.ts` wrapper,
// decision logic here). Lives under agent/lib/, which Eve does not load as a
// tool/channel.
//
// SECRET HANDLING: `interactionToken` is a short-lived credential, and the
// followup URL embeds it directly (`buildFollowupUrl`). Neither is ever
// logged, nor embedded in a thrown Error message, anywhere in this module.
// The fallback path DOES log on failure (`deliverDiscordBubble`, below) —
// the original bug was invisible precisely because that path used to be a
// silent `catch {}` — but only the numeric HTTP status and Discord's numeric
// `error.code`, never the token, never the URL, never the response body's
// free-text `message`/`errors` (Discord's 400 "Invalid Form Body" responses
// can echo back submitted content). The only thrown errors here are
// re-throws of whatever `postViaBot` itself throws, which callers already do
// not construct from the token (see agent/channels/discord.ts).

/** Discord's REST API base (v10). */
export const DISCORD_API_BASE = "https://discord.com/api/v10";

/**
 * Discord's hard per-message content length limit — the SAME constant eve's
 * own runtime uses for `channel.discord.post()` (`DISCORD_MESSAGE_CONTENT_MAX_LENGTH
 * = 2e3`, verified against eve@0.19.0's REAL compiled runtime,
 * apps/jace/.output/server/_libs/eve.mjs). The followup webhook path has no
 * chunking of its own (unlike `channel.discord.post()`, which eve itself
 * chunks via its `splitDiscordMessageContent`) — see `chunkDiscordContent`.
 *
 * @type {number}
 */
export const DISCORD_MESSAGE_CONTENT_MAX_LENGTH = 2000;

/**
 * The `allowed_mentions` value eve's own `normalizeMessageBody` defaults
 * every Discord message body to when the caller doesn't set one (verified
 * against eve.mjs: `DISCORD_NO_MENTIONS = { parse: [] }`, applied whenever
 * `body.allowed_mentions === undefined`). The followup webhook path built its
 * own bare `{content}` body with no such default, so Discord parsed mentions
 * normally — a live abuse vector (Jace's reply could ping `@everyone`/`@here`/
 * roles/users, including text echoed back from a stranger's message) and a
 * regression against `channel.discord.post()`'s existing behavior. Applied to
 * every followup POST in `deliverDiscordBubble` below.
 *
 * @type {{ parse: readonly string[] }}
 */
export const DISCORD_NO_MENTIONS = Object.freeze({ parse: [] });

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
 * object passed to `args.receive(discord, { auth, ... })` UNCHANGED into BOTH
 * `ctx.session.auth.current.attributes` (refreshed on every subsequent turn)
 * AND `ctx.session.auth.initiator.attributes` (set ONCE, at session start,
 * and never updated again) — see `resolveSessionAuthAttributes` below for
 * which one a caller should read, and why. Either way, `attributes` is the
 * ONLY seam that reliably carries these fields from
 * apps/console/lib/channel-dispatch.ts's `buildDoorInitiatorAuth` through to
 * this channel's `message.completed` handler — the proactive
 * `DiscordReceiveTarget` shape eve exposes for `receive()` has no room for
 * either field (verified against eve@0.19.0's own `discordChannel.d.ts`).
 * This function itself doesn't care which of `current`/`initiator` the
 * caller resolved `attributes` from — it only validates the credential shape.
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
 * CRITICAL FIX (fix-1-brief.md finding 1): resolve the followup-eligible
 * attributes out of eve's `ctx.session.auth` shape, preferring `current`
 * over `initiator`.
 *
 * Verified against eve@0.19.0's REAL compiled runtime
 * (apps/jace/.output/server/_libs/eve.mjs) — NOT just its `.d.ts` stubs,
 * which is how this got read wrong the first time:
 *
 *   - `session.auth` is built by `buildSessionHandle` as
 *     `{ current: <AuthKey>, initiator: <InitiatorAuthKey> }`.
 *   - `InitiatorAuthKey` is set exactly ONCE, in `buildRunContext`, when a
 *     session is first created (`i.set(InitiatorAuthKey, r.initiatorAuth ?? a)`)
 *     — never again for the life of that session.
 *   - `AuthKey` (`current`) is refreshed on every subsequent turn: the
 *     `deliver`-turn code path runs
 *     `t.input?.kind === "deliver" && t.input.auth !== void 0 && l.set(AuthKey, t.input.auth ?? null)`
 *     on every turn a resumed/continued session receives.
 *
 * A Discord conversation is exactly this "resumed session" shape (Jace's
 * `jace_sessions` ledger + `bindEveSession` keep the SAME eve session across
 * turns — see channel-dispatch.ts's `getOrCreateJaceSession`). So on turn 2+
 * of any conversation, `initiator` still holds turn 1's interaction token —
 * reading it (as this code used to) either 404s once the 15-minute window
 * elapses (silent-fallback-fails-too regression of the exact bug this PR
 * fixes) or, worse, inside the window, delivers the reply against the
 * WRONG (turn 1's) interaction credential with no error at all.
 *
 * On turn 1 of any session, `current` and `initiator` are seeded from the
 * SAME value (`buildRunContext` above), so preferring `current` is a strict
 * superset of always reading `initiator` — every turn-1 case behaves
 * identically; only turn 2+ changes, and only for the better.
 *
 * @param {{ current?: { attributes?: Record<string, unknown> | null } | null, initiator?: { attributes?: Record<string, unknown> | null } | null } | null | undefined} auth
 * @returns {Record<string, unknown> | null | undefined}
 */
export function resolveSessionAuthAttributes(auth) {
  return auth?.current?.attributes ?? auth?.initiator?.attributes;
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
 * Best-effort pull of Discord's small numeric `error.code` out of a
 * followup response body (Discord's documented JSON error shape is
 * `{ message: string, code: number, errors?: object }`). Returns `null` for
 * any non-object body or a non-numeric/absent `code` — never throws.
 *
 * Used ONLY for the fallback log line (finding 4): deliberately reads just
 * the numeric `code`, never `message`/`errors`, since Discord's 400
 * "Invalid Form Body" responses can echo back submitted content in `errors`.
 *
 * @param {unknown} body
 * @returns {number | null}
 */
export function extractDiscordErrorCode(body) {
  if (!body || typeof body !== "object") return null;
  const code = /** @type {{ code?: unknown }} */ (body).code;
  return typeof code === "number" ? code : null;
}

/**
 * Split `content` into <=2000-char pieces for the followup webhook path
 * (fix-1-brief.md finding 3), preferring to break on the last newline
 * at-or-before the limit, then the last space, then a hard cut — the SAME
 * limit and algorithm eve's own `splitDiscordMessageContent` uses for
 * `channel.discord.post()` (verified against eve@0.19.0's REAL compiled
 * runtime, apps/jace/.output/server/_libs/eve.mjs), so a long reply reads
 * identically whichever path delivers it.
 *
 * The followup path had no chunking of its own before this fix: POSTing raw
 * content over 2000 chars gets a Discord 400, and in the private channel
 * this whole PR exists to fix, the bot-post fallback ALSO can't reach the
 * channel — so an unchunked long reply was lost entirely, not just
 * mis-formatted.
 *
 * @param {string} content
 * @returns {string[]} always at least one element, even for empty input
 */
export function chunkDiscordContent(content) {
  const text = String(content ?? "");
  if (text.length <= DISCORD_MESSAGE_CONTENT_MAX_LENGTH) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > DISCORD_MESSAGE_CONTENT_MAX_LENGTH) {
    let splitAt = remaining.lastIndexOf("\n", DISCORD_MESSAGE_CONTENT_MAX_LENGTH);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(" ", DISCORD_MESSAGE_CONTENT_MAX_LENGTH);
    if (splitAt <= 0) splitAt = DISCORD_MESSAGE_CONTENT_MAX_LENGTH;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  chunks.push(remaining);
  return chunks;
}

/**
 * Deliver one reply bubble: the interaction followup webhook when a valid
 * credential is available AND every chunk of the attempt succeeds, else the
 * existing bot-authenticated channel post.
 *
 * Chunks `content` at 2000 chars (`chunkDiscordContent`, finding 3) and
 * POSTs each chunk to the followup webhook in order, each with
 * `allowed_mentions: {parse:[]}` (`DISCORD_NO_MENTIONS`, finding 2). If
 * EVERY chunk 2xxs, delivery is done. If any chunk's attempt fails — a
 * non-2xx response or `postFollowup` itself throwing (finding 4: both
 * outcomes trigger the fallback, not just one) — attempts stop immediately
 * and the WHOLE bubble falls back to `postViaBot` (which chunks it itself,
 * via eve's own `channel.discord.post()` -> `splitDiscordMessageContent`).
 * Falling back for the whole bubble rather than only the un-sent remainder
 * can rarely duplicate an already-delivered leading chunk (e.g. the token
 * expires mid-bubble, between chunk 1 and chunk 2) — an accepted tradeoff,
 * since the alternative (silently dropping the rest of a long reply) is
 * exactly the failure mode this fix exists to close.
 *
 * On any fallback triggered by a followup attempt (not by a missing
 * credential — that's the ordinary, expected case for e.g. a channel the
 * bot already has permission in), this logs the numeric HTTP status and
 * Discord's numeric error code — finding 4: the original prod bug was
 * invisible precisely because this path used to be a silent `catch {}`.
 * SECRET SAFETY: NEVER the token, NEVER the followup URL (which embeds the
 * token), NEVER the response body's free-text `message`/`errors` — see
 * `extractDiscordErrorCode`.
 *
 * If `postViaBot` itself throws — followup unavailable/failed AND the bot
 * post also fails — that error propagates unguarded, exactly matching
 * today's behavior for a channel with no interaction token at all.
 *
 * @param {{
 *   content: string,
 *   attributes?: Record<string, unknown> | null,
 *   postFollowup: (url: string, init: { method: string, headers: Record<string,string>, body: string }) => Promise<{ status: number, body?: unknown }>,
 *   postViaBot: () => Promise<unknown>,
 * }} args
 * @returns {Promise<{ delivered: "followup" | "bot" }>}
 */
export async function deliverDiscordBubble({ content, attributes, postFollowup, postViaBot }) {
  const credentials = extractFollowupCredentials(attributes);
  if (credentials) {
    const url = buildFollowupUrl(credentials);
    const chunks = chunkDiscordContent(content);
    let failure = null;
    for (const chunk of chunks) {
      try {
        const res = await postFollowup(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: chunk, allowed_mentions: DISCORD_NO_MENTIONS }),
        });
        if (!isFollowupSuccess(res?.status)) {
          failure = {
            status: typeof res?.status === "number" ? res.status : null,
            discordErrorCode: extractDiscordErrorCode(res?.body),
          };
          break;
        }
      } catch {
        // Network-level failure on the followup attempt (e.g. the shared
        // bot process can't reach discord.com) — no HTTP response to read a
        // status/code from at all.
        failure = { status: null, discordErrorCode: null };
        break;
      }
    }
    if (!failure) return { delivered: "followup" };
    console.error(
      "[discord-followup] followup delivery failed, falling back to bot post",
      failure,
    );
  }
  await postViaBot();
  return { delivered: "bot" };
}

/**
 * Deliver a full model reply as one or more Discord bubbles: split `text` on
 * the model's own paragraph breaks (the injected `splitMessage` — i.e.
 * `splitIntoChatMessages`, see chat-split.core.mjs), show typing between
 * bubbles after the first (never before the first), and deliver each bubble
 * via `deliverDiscordBubble` above (followup-first with its own chunking,
 * mandatory bot-post fallback).
 *
 * This is the REAL runtime path `agent/channels/discord.ts`'s
 * `message.completed` handler delegates to (fix-1-brief.md minor: "move the
 * bubble loop into the core module ... and test it for real"). The loop used
 * to live directly in that `.ts` Eve channel module, where
 * discord-channel.test.mjs could only regex-match the source text — `node
 * --test` cannot import a `.ts` Eve channel module without a TS loader, so
 * the loop (and the session-auth attribute selection the caller resolves via
 * `resolveSessionAuthAttributes` and passes in as `attributes`) was never
 * actually executed by any test. Moving it here makes it a plain
 * dependency-injected function, provably exercised by
 * discord-followup.core.test.mjs.
 *
 * @param {{
 *   text: string,
 *   attributes?: Record<string, unknown> | null,
 *   postFollowup: (url: string, init: { method: string, headers: Record<string,string>, body: string }) => Promise<{ status: number, body?: unknown }>,
 *   postViaBot: (message: string) => Promise<unknown>,
 *   startTyping: () => Promise<unknown>,
 *   splitMessage: (text: string) => string[],
 * }} args
 * @returns {Promise<{ delivered: ("followup" | "bot")[] }>}
 */
export async function deliverDiscordReply({
  text,
  attributes,
  postFollowup,
  postViaBot,
  startTyping,
  splitMessage,
}) {
  const messages = splitMessage(text);
  const delivered = [];
  for (const [index, message] of messages.entries()) {
    if (index > 0) await startTyping();
    const result = await deliverDiscordBubble({
      content: message,
      attributes,
      postFollowup,
      postViaBot: () => postViaBot(message),
    });
    delivered.push(result.delivered);
  }
  return { delivered };
}

// Pure, dependency-free core for Jace's Slack reply WORKER SENDER (Task 4,
// docs/superpowers/specs/2026-07-29-slack-multi-workspace-design.md §4) — the
// Slack-facing half of `agent/channels/slack.ts`'s `message.completed`
// handler.
//
// jace no longer posts to Slack directly. Slack issues a SEPARATE bot token
// per workspace install, and eve's Slack channel cannot safely carry one:
// its `botToken` credential is a thunk resolved with NO arguments, bound
// once at `slackChannel()` construction, process-wide — there is no per-turn
// hook to swap in the right customer's token. The only per-turn value that
// would survive is ambient context (an AsyncLocalStorage set at webhook
// time), and that is unsafe here too: eve's `turnStep` runs on
// `@workflow/core`, which serializes, parks, and resumes turns — an ambient
// value can be stale by the time a reply posts, and stale here means posting
// one customer's reply with another customer's bot token. See the design
// doc's §4 for the full argument.
//
// So the reply hands back to the console over HTTP instead — exactly the
// hand-back `console_chat_reply.core.mjs` already does for the console
// channel — and the console (the one place that holds every team's
// installation) resolves the INSTALLING team's own bot token and posts via
// `chat.postMessage`.
//
// Same env resolution (JACE_CONSOLE_BASE_URL / JACE_CONSOLE_TOKEN) as every
// other Jace->console core module; deliberately duplicated rather than
// shared — see create_workspace.core.mjs's own note on why each core module
// here stays dependency-free of the others.
//
// Unlike this directory's TOOL-facing core modules — which never throw and
// instead return a degraded/failure value the model can relay — this
// mirrors console_chat_reply.core.mjs: it's called from a channel's
// `message.completed` EVENT HANDLER, not a tool a model calls, so a delivery
// failure THROWS and the caller lets it propagate unguarded, same as every
// other channel's post().
//
// TEAM ID IS THE WHOLE POINT: `postSlackReply` throws BEFORE making any
// network call when `teamId` is missing or blank — there is no default that
// could ever be safe to fall back to (posting with SOME other team's token
// is exactly the cross-tenant leak this design exists to prevent), so this
// is enforced client-side too rather than relying solely on the console's
// own 400/404.

export const SLACK_REPLY_PATH = "/api/v1/runner/slack-reply";

/**
 * Resolve the console endpoint + bearer from the environment. Trims both,
 * strips a trailing slash from the base URL, and reports which var(s) are
 * missing. Byte-identical logic to console_chat_reply.core.mjs's own
 * `resolveConsoleConfig` — duplicated, not imported (see this module's
 * header note).
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ ok: true, baseUrl: string, token: string } | { ok: false, missing: string[] }}
 */
export function resolveConsoleConfig(env = {}) {
  const baseUrl = String(env.JACE_CONSOLE_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const token = String(env.JACE_CONSOLE_TOKEN ?? "").trim();
  const missing = [];
  if (!baseUrl) missing.push("JACE_CONSOLE_BASE_URL");
  if (!token) missing.push("JACE_CONSOLE_TOKEN");
  if (missing.length) return { ok: false, missing };
  return { ok: true, baseUrl, token };
}

/** Build the Slack-reply URL. */
export function buildSlackReplyUrl(baseUrl) {
  return `${baseUrl}${SLACK_REPLY_PATH}`;
}

/**
 * Pull the Slack team id out of eve's `ctx.session.auth`, preferring
 * `current` over `initiator` — the SAME preference (and the SAME reason)
 * `discord-followup.core.mjs`'s `resolveSessionAuthAttributes` uses:
 * `initiator` is captured ONCE at session start and never updated again, so
 * on turn 2+ of a resumed conversation it can hold a stale value while
 * `current` is refreshed every turn. On turn 1 both are seeded identically,
 * so preferring `current` only ever changes turn 2+ behavior, for the
 * better. Verified against the SAME eve@0.19.0 compiled runtime
 * (apps/jace/.output/server/_libs/eve.mjs) discord-followup.core.mjs cites.
 *
 * `attributes.teamId` is written by the console's `channel-dispatch.ts`
 * (`buildDoorInitiatorAuth`) ONLY for a Slack-originated row (Task 4) —
 * never inferred here from anything else on `auth`. Returns `""` (never
 * `undefined`/`null`) for any missing/malformed shape so callers can do a
 * single truthiness check.
 *
 * @param {{ current?: { attributes?: Record<string, unknown> | null } | null, initiator?: { attributes?: Record<string, unknown> | null } | null } | null | undefined} auth
 * @returns {string}
 */
export function resolveSlackReplyTeamId(auth) {
  const attributes = auth?.current?.attributes ?? auth?.initiator?.attributes;
  const teamId = attributes && typeof attributes === "object" ? attributes.teamId : undefined;
  return typeof teamId === "string" ? teamId.trim() : "";
}

/**
 * POST a completed Slack reply back to the console so it lands in Slack with
 * the INSTALLING team's own bot token. Throws on ANY failure (unset config,
 * a missing teamId/channelId, a network error, or a non-2xx response) — the
 * caller (`agent/channels/slack.ts`'s `message.completed` handler) lets it
 * propagate, exactly like every other channel's post().
 *
 * `teamId`/`channelId` are validated and trimmed BEFORE the network call —
 * see this module's header note on why a missing team id is refused here,
 * not only by the console.
 *
 * @param {{ teamId: string, channelId: string, threadTs?: string, text: string,
 *           env?: Record<string, string|undefined>,
 *           transport: (url: string, init: { method: string, headers: Record<string,string>, body: string }) =>
 *             Promise<{ status: number }> }} args
 * @returns {Promise<void>}
 */
export async function postSlackReply({ teamId, channelId, threadTs, text, env = {}, transport }) {
  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) {
    throw new Error(
      `slack reply: missing ${cfg.missing.join(", ")} — cannot deliver Jace's Slack reply.`,
    );
  }

  const trimmedTeamId = typeof teamId === "string" ? teamId.trim() : "";
  if (!trimmedTeamId) {
    throw new Error(
      "slack reply: no Slack team id on this session — refusing to post without knowing which installation's token to use.",
    );
  }

  const trimmedChannelId = typeof channelId === "string" ? channelId.trim() : "";
  if (!trimmedChannelId) {
    throw new Error("slack reply: missing channelId — cannot deliver Jace's Slack reply.");
  }

  const body = { teamId: trimmedTeamId, channelId: trimmedChannelId, text };
  if (typeof threadTs === "string" && threadTs.trim()) {
    body.threadTs = threadTs;
  }

  const res = await transport(buildSlackReplyUrl(cfg.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.token}`,
    },
    body: JSON.stringify(body),
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`slack reply: console returned ${res.status}`);
  }
}

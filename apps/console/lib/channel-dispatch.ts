/**
 * The Jace dispatcher (issue #1262 PR ②) — drains `channel_inbox`, mapping
 * each claimed message to its Jace conversation and running the Eve turn.
 *
 * This is what makes a stranger's DM to the shared Telegram bot (ingested by
 * the webhook, PR ①) become a real Jace conversation (AC1): claim -> resolve
 * conversation -> workspace via the #1261 identity spine
 * (`resolveConversationWorkspace`) -> run the turn through Eve's cross-channel
 * `hosted-inbound` door -> record the `jace_sessions` ledger row
 * (`bindEveSession`) -> complete.
 *
 * THIN, IN-PROCESS, claim-until-empty drain — not a worker process. A single
 * webhook request kicks a drain that races every OTHER queued message to
 * completion, one row at a time. `claimNextChannelMessage` is already
 * concurrency-safe cross-process (`FOR UPDATE SKIP LOCKED` + advisory locks —
 * see packages/db-postgres/src/queries/channel_inbox.ts); the in-process
 * latch below only avoids pointless parallel drains within ONE console
 * instance. A real worker pool (apps/worker) replaces this in Wave 2 — see
 * annex-1262-recon.md's "Today's paths" section. The claim query's
 * per-workspace fairness cap does not yet special-case NULL-workspace (intro)
 * rows; that gap is noted for Wave 2, not fixed here.
 */
import {
  reclaimStaleChannelMessages,
  claimNextChannelMessage,
  completeChannelMessage,
  failChannelMessage,
  getChatIdentity,
  resolveConversationWorkspace,
  pinConversationWorkspace,
  getOrCreateIntroJaceSession,
  getOrCreateJaceSession,
  bindEveSession,
  latestRunForIssue,
  type ClaimedChannelInboxRow,
  type ReachableWorkspace,
  type ResolveConversationWorkspaceResult,
} from "@agentrail/db-postgres";
import { sendSystemTelegramMessage, buildWorkspaceChoiceMessage, buildPinConfirmationMessage } from "./telegram-system-message";
import { sendSystemDiscordMessage } from "./discord-system-message";
import { buildRunOutcomeReplyPreface, type RunOutcomeReplyContext } from "./outcome-format";

/**
 * The NON-SECRET destination key each channel's hosted-inbound `target`
 * carries — the SAME mapping `apps/jace/agent/lib/run_outcome.core.mjs`
 * (outbound) and its generalized `hosted_inbound.core.mjs` (inbound) use, so
 * this door and that one can never drift apart. Telegram `chatId`; Discord
 * (and, once #1285 lands, Slack) `channelId` — every webhook route for those
 * channels enqueues its conversation id under the SAME internal `chatId`
 * payload field Telegram already uses (see `extractPayload` below, left
 * byte-unchanged), and this map only renames it at the LAST moment, when
 * building the outgoing hosted-inbound request.
 */
const HOSTED_INBOUND_TARGET_KEY: Record<string, "chatId" | "channelId"> = {
  telegram: "chatId",
  discord: "channelId",
};

/**
 * Dispatch a system (non-model) message to the right channel's own sender —
 * additive: Telegram's `sendSystemTelegramMessage` import above and every
 * one of its call sites in `processRow`'s 'ask' branch are UNCHANGED by this
 * (#1284); this only adds the discord case alongside it (issue #1364 is in
 * flight on the same Telegram 'ask'/signup path — keeping that code
 * untouched minimizes the eventual merge conflict). #1285 (Slack) appends its
 * own case here the same way.
 */
async function sendSystemChannelMessage(
  channel: string,
  targetId: string,
  text: string,
  messageThreadId?: string
) {
  if (channel === "discord") return sendSystemDiscordMessage(targetId, text);
  return sendSystemTelegramMessage(targetId, text, messageThreadId);
}

const EVE_HOST = process.env["EVE_HOST"] || "http://127.0.0.1:2000";

/**
 * The jace hosted-inbound door route (`apps/jace/agent/channels/hosted-inbound.ts`
 * -> `/eve/v1/hosted-inbound`). Overridable for tests / non-default
 * topologies, mirroring `notify.ts`'s `JACE_RUN_OUTCOME_URL` convention.
 */
const HOSTED_INBOUND_URL =
  process.env["JACE_HOSTED_INBOUND_URL"] || `${EVE_HOST}/eve/v1/hosted-inbound`;

// An Eve dispatch-acknowledge should be fast: hosted-inbound.ts's
// args.receive() resolves at DISPATCH time (session created), not at turn
// completion — see that file's header comment. 60s is generous headroom for
// that, not a turn-completion budget. Bounding it matters because a HUNG
// (never-settling) fetch would otherwise wedge the module-level
// `inflightDrain` latch below forever — process-wide dispatch death until
// restart. Mirrors the fetch-with-timeout pattern already used by
// app/api/v1/workspaces/[workspaceId]/connectors/secret/telegram.ts.
const EVE_TURN_TIMEOUT_MS = 60_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EVE_TURN_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface DispatchResult {
  processed: number;
  failed: number;
}

/** The message-kind inbox payload this dispatcher understands (telegram, v1 = DM-first). */
interface TelegramInboxPayload {
  chatId: number | string;
  text: string;
  messageThreadId?: number | string;
  /** #1277 — set by the webhook route when this message replies to a
   * parseable run-outcome notification. See `withReplyContextPreface`. */
  replyContext?: RunOutcomeReplyContext;
}

/**
 * TOLERANT extraction for the #1277 `replyContext` field — malformed shapes
 * (wrong `kind`, non-integer/non-positive `issueNumber`) resolve to
 * `undefined` rather than failing the whole row, same tolerance
 * `messageThreadId` already gets below. This is internal, already-parsed
 * data (the webhook route only ever writes a well-formed value via
 * `parseOutcomeIssueNumber`), so this is belt-and-suspenders, not an
 * attacker-input boundary.
 */
function extractReplyContext(value: unknown): RunOutcomeReplyContext | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  if (r["kind"] !== "run_outcome") return undefined;
  const issueNumber = r["issueNumber"];
  if (
    typeof issueNumber !== "number" ||
    !Number.isSafeInteger(issueNumber) ||
    issueNumber <= 0
  ) {
    return undefined;
  }
  return { kind: "run_outcome", issueNumber };
}

/**
 * Extract + validate the fields this dispatcher needs from a claimed row's
 * loosely-typed `payload` (jsonb, `Record<string, unknown>` at the query
 * layer). Returns `null` on any malformed shape so the caller can fail the
 * row rather than crash the loop — this is internal, already-enqueued data
 * (PR ①'s webhook route builds it), so a malformed shape here means a
 * wiring bug, not attacker input.
 */
function extractPayload(payload: unknown): TelegramInboxPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const chatId = p["chatId"];
  const text = p["text"];
  if (
    (typeof chatId !== "number" && typeof chatId !== "string") ||
    typeof text !== "string"
  ) {
    return null;
  }
  const messageThreadId = p["messageThreadId"];
  const result: TelegramInboxPayload = { chatId, text };
  if (typeof messageThreadId === "number" || typeof messageThreadId === "string") {
    result.messageThreadId = messageThreadId;
  }
  const replyContext = extractReplyContext(p["replyContext"]);
  if (replyContext) result.replyContext = replyContext;
  return result;
}

/**
 * Parse an 'ask' conversation's reply as a workspace choice: an exact
 * case-insensitive workspace-name match, or (only if no name matches) an
 * integer 1..N (1-indexed against `options`). Returns `null` for anything
 * else (the "invalid reply" path, which re-sends the same options).
 *
 * Name match MUST run before the numeric-index check: a workspace can
 * legitimately be named "2", and it may not sit at position 2 — checking
 * the index first would silently mis-pin whatever happens to occupy that
 * position instead of the workspace the reply actually names.
 */
function parseWorkspaceChoice(
  text: string,
  options: readonly ReachableWorkspace[]
): ReachableWorkspace | null {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const byName = options.find((option) => option.name.toLowerCase() === lower);
  if (byName) return byName;
  if (/^\d+$/.test(trimmed)) {
    const index = Number(trimmed) - 1;
    return options[index] ?? null;
  }
  return null;
}

/**
 * The initiator identity carried into `session.auth.initiator` — the ONLY
 * way Jace's tools/subagents can later attribute a session back to the
 * originating chat identity / workspace (see annex-eve-internals.md's
 * `auth.initiator` section). Mirrors `notify.ts`'s `jaceInitiatorAuth` shape
 * and voice; deliberately a separate small helper (not imported from
 * notify.ts, which is the OUTBOUND run-outcome path — unrelated lifecycle).
 *
 * `principalId` is the workspace when one is resolved, else the chat
 * identity (an intro conversation has no workspace yet). `workspaceId` is
 * `null`, not omitted, in `attributes` for an intro turn — the console side
 * of this contract is a plain JSON object, not eve's `SessionAuthContext`
 * type, so this is not constrained by that interface's `string`-only
 * attribute values (only the jace-side receiver would be, and it forwards
 * `auth` through unchanged without re-typing it — see hosted-inbound.ts).
 */
function buildDoorInitiatorAuth(params: {
  chatIdentityId: string;
  workspaceId: string | null;
  channel: string;
  conversationKey: string;
}): Record<string, unknown> {
  return {
    authenticator: "agentrail",
    principalType: "service",
    principalId: params.workspaceId ?? params.chatIdentityId,
    attributes: {
      chatIdentityId: params.chatIdentityId,
      workspaceId: params.workspaceId,
      channel: params.channel,
      conversationKey: params.conversationKey,
    },
  };
}

type EveTurnOutcome =
  | { ok: true; sessionId: string; continuationToken: string }
  | { ok: false; reason: string };

/**
 * POST one turn to Jace's hosted-inbound door and resolve to a discriminated
 * result — never throws; a network failure and a non-200 both resolve to
 * `ok: false` so the caller can `failChannelMessage` either the same way.
 */
async function runEveTurn(params: {
  message: string;
  /** Which hosted-inbound channel module receives this turn (#1284/#1285 —
   * default "telegram" so every pre-existing call site, which never set
   * this, is byte-unchanged). */
  channel?: string;
  chatId: number | string;
  messageThreadId?: number | string;
  auth: Record<string, unknown>;
}): Promise<EveTurnOutcome> {
  const channel = params.channel ?? "telegram";
  // The wire-level target key is channel-specific (Telegram `chatId`;
  // Discord/Slack `channelId` — see HOSTED_INBOUND_TARGET_KEY above); the
  // VALUE is always `params.chatId` regardless of channel, since every
  // webhook route (telegram/discord/slack) enqueues its conversation id
  // under that same internal payload field.
  const targetKey = HOSTED_INBOUND_TARGET_KEY[channel] ?? "chatId";
  let response: Response;
  try {
    response = await fetchWithTimeout(HOSTED_INBOUND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: params.message,
        channel,
        target: {
          [targetKey]: params.chatId,
          ...(params.messageThreadId !== undefined
            ? { messageThreadId: params.messageThreadId }
            : {}),
        },
        auth: params.auth,
      }),
    });
  } catch (err) {
    return {
      ok: false,
      reason: `hosted-inbound unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!response.ok) {
    return { ok: false, reason: `hosted-inbound returned ${response.status}` };
  }

  const body = (await response.json().catch(() => null)) as
    | { sessionId?: unknown; continuationToken?: unknown }
    | null;
  if (!body || typeof body.sessionId !== "string") {
    return { ok: false, reason: "hosted-inbound response missing sessionId" };
  }
  return {
    ok: true,
    sessionId: body.sessionId,
    continuationToken: typeof body.continuationToken === "string" ? body.continuationToken : "",
  };
}

/**
 * #1277 (replyable run-outcome threads) — when the inbound payload carries a
 * run-outcome `replyContext` (the webhook parsed it out of a Telegram
 * reply's quoted text), resolve the latest run for that issue
 * WORKSPACE-SCOPED to the conversation's OWN server-resolved `workspaceId`
 * — never anything read out of the payload/quoted text itself, see
 * route.ts's `resolveReplyContext` threat-model note — and prepend a
 * server-built bracketed preface to the message Jace receives.
 *
 * No workspace yet (an 'intro' conversation — `workspaceId` null) or no
 * `replyContext` at all: the message is returned UNTOUCHED, byte-identical
 * to before this feature existed. (An 'intro' conversation replying to a
 * run-outcome ping is not a real scenario in practice — a ping is only ever
 * sent to an already-connected/bound conversation — but the guard is here
 * regardless: there is no workspace to scope a lookup to.)
 */
async function withReplyContextPreface(
  workspaceId: string | null,
  payload: TelegramInboxPayload
): Promise<string> {
  if (!workspaceId || !payload.replyContext) return payload.text;
  const found = await latestRunForIssue(workspaceId, payload.replyContext.issueNumber);
  const preface = buildRunOutcomeReplyPreface(payload.replyContext.issueNumber, found);
  return `${preface}\n${payload.text}`;
}

/**
 * Process exactly one claimed row end to end. NEVER throws: every failure
 * mode — malformed payload, no identity, sidecar down, an unexpected
 * exception anywhere in the chain — resolves to `"failed"` via
 * `failChannelMessage`, so the drain loop can always move on to the next
 * row ("never kill the loop").
 */
async function processRow(row: ClaimedChannelInboxRow): Promise<"completed" | "failed"> {
  try {
    if (row.kind !== "message") {
      // Approvals ride the Eve-native callback_query path today (out of
      // scope for this PR — see the brief's "Out of scope" section); a
      // non-message kind here would be a future kind this dispatcher does
      // not yet understand, not a crash.
      await failChannelMessage(
        row.id,
        `channel-dispatch: unsupported inbox kind '${row.kind}' (not handled by this dispatcher yet)`
      );
      return "failed";
    }

    const payload = extractPayload(row.payload);
    if (!payload) {
      await failChannelMessage(row.id, "channel-dispatch: malformed payload (missing chatId/text)");
      return "failed";
    }

    // INVARIANT this dispatcher assumes but does not enforce: channel_inbox's
    // (channel, senderId) here MUST equal the (platform, platformUserId) a
    // chat_identities row was created under. The Telegram webhook (route.ts)
    // guarantees it today (same String(from.id) feeds both). A future
    // Discord/Slack writer that breaks this pairing dead-letters silently below.
    const identity = await getChatIdentity(row.channel, row.senderId);
    if (!identity) {
      await failChannelMessage(
        row.id,
        `channel-dispatch: no chat identity for ${row.channel}/${row.senderId}`
      );
      return "failed";
    }
    const chatIdentityId = identity.id;

    let decision: ResolveConversationWorkspaceResult = await resolveConversationWorkspace({
      chatIdentityId,
      channel: row.channel,
      conversationKey: row.conversationKey,
    });

    // --- 'ask': the reply itself may BE the workspace choice; consumed, never forwarded to Jace. ---
    if (decision.kind === "ask") {
      const chosen = parseWorkspaceChoice(payload.text, decision.options);
      if (chosen) {
        const pin = await pinConversationWorkspace({
          chatIdentityId,
          channel: row.channel,
          conversationKey: row.conversationKey,
          workspaceId: chosen.id,
        });
        if (pin.ok) {
          await sendSystemChannelMessage(
            row.channel,
            String(payload.chatId),
            buildPinConfirmationMessage(chosen.name),
            payload.messageThreadId !== undefined ? String(payload.messageThreadId) : undefined
          );
          await completeChannelMessage(row.id);
          return "completed";
        }
        // Refused (not_reachable / already_pinned_elsewhere): fall through
        // to the same "invalid choice" handling below. A concurrent pin
        // means the NEXT message resolves as 'pinned' on its own.
      }
      await sendSystemChannelMessage(
        row.channel,
        String(payload.chatId),
        buildWorkspaceChoiceMessage(decision.options),
        payload.messageThreadId !== undefined ? String(payload.messageThreadId) : undefined
      );
      await completeChannelMessage(row.id);
      return "completed";
    }

    // --- resolve the effective workspaceId (if any) + the jace_sessions ledger row ---
    let workspaceId: string | null = null;
    let ledgerSessionId: string;

    if (decision.kind === "intro") {
      const session = await getOrCreateIntroJaceSession(chatIdentityId, row.channel, row.conversationKey);
      ledgerSessionId = session.id;
    } else {
      if (decision.kind === "single") {
        const pin = await pinConversationWorkspace({
          chatIdentityId,
          channel: row.channel,
          conversationKey: row.conversationKey,
          workspaceId: decision.workspaceId,
        });
        if (!pin.ok) {
          // Races are expected (annex #1261 contract): re-resolve ONCE and
          // proceed with whatever it is now, rather than retry in a loop.
          decision = await resolveConversationWorkspace({
            chatIdentityId,
            channel: row.channel,
            conversationKey: row.conversationKey,
          });
          if (decision.kind !== "pinned") {
            // Unreachable in practice — a pin refusal implies a
            // workspace-anchored session now exists for this
            // (channel, conversationKey). Fail loudly rather than guess.
            await failChannelMessage(
              row.id,
              `channel-dispatch: re-resolve after pin refusal yielded unexpected kind '${decision.kind}'`
            );
            return "failed";
          }
        }
      }
      // decision is now 'single' (pinned this turn) or 'pinned' (already was,
      // or just became so via the re-resolve above) — both carry workspaceId.
      workspaceId = (decision as { workspaceId: string }).workspaceId;
      const session = await getOrCreateJaceSession(workspaceId, row.channel, row.conversationKey);
      ledgerSessionId = session.id;
    }

    const auth = buildDoorInitiatorAuth({
      chatIdentityId,
      workspaceId,
      channel: row.channel,
      conversationKey: row.conversationKey,
    });

    const message = await withReplyContextPreface(workspaceId, payload);

    const turn = await runEveTurn({
      message,
      channel: row.channel,
      chatId: payload.chatId,
      messageThreadId: payload.messageThreadId,
      auth,
    });

    if (!turn.ok) {
      await failChannelMessage(row.id, `channel-dispatch: ${turn.reason}`);
      return "failed";
    }

    await bindEveSession(ledgerSessionId, turn.sessionId);
    await completeChannelMessage(row.id);
    return "completed";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await failChannelMessage(row.id, message);
    } catch (failErr) {
      // Even the failure write itself is best-effort here: never let a
      // broken DB write take the whole drain down.
      console.error("[channel-dispatch] failChannelMessage itself failed:", failErr);
    }
    return "failed";
  }
}

async function drainQueue(): Promise<DispatchResult> {
  await reclaimStaleChannelMessages();

  let processed = 0;
  let failed = 0;
  for (;;) {
    const claimed = await claimNextChannelMessage();
    if (!claimed) break;
    const outcome = await processRow(claimed);
    if (outcome === "failed") failed++;
    else processed++;
  }
  return { processed, failed };
}

/** Module-level latch: collapses concurrent kicks into a single drain. */
let inflightDrain: Promise<DispatchResult> | null = null;

/**
 * Drain `channel_inbox` until empty: claim -> resolve conversation ->
 * workspace -> run the Eve turn (or consume an 'ask' reply) -> ledger ->
 * complete/fail, one row at a time, never throwing past a single poisoned
 * row.
 *
 * Concurrency: `claimNextChannelMessage` is already safe across processes
 * (`FOR UPDATE SKIP LOCKED` + advisory locks); this in-process latch only
 * collapses redundant PARALLEL drains within one console instance (e.g. two
 * webhook requests landing back to back) into the one already running. The
 * latch check + assignment below is synchronous (no `await` before
 * `inflightDrain` is set), so two synchronous calls in the same tick always
 * observe it correctly. A real worker process replaces this whole function
 * in Wave 2.
 *
 * `withReplyContextPreface` (issue #1277): the ONE seam where an inbound
 * payload's optional `replyContext` (a reply to a run-outcome ping, parsed
 * server-side by the webhook route) turns into a workspace-scoped
 * `latestRunForIssue` lookup and a bracketed preface prepended to the
 * message Jace actually receives — see that function's own doc comment for
 * the threat-model note.
 */
export function dispatchQueuedChannelMessages(): Promise<DispatchResult> {
  if (inflightDrain) return inflightDrain;
  const run = drainQueue().finally(() => {
    inflightDrain = null;
  });
  inflightDrain = run;
  return run;
}

// Jace's native iMessage channel (#1100) — hand-rolled over LoopMessage.
//
// Eve ships first-party channels for telegram/discord/slack but NOT iMessage, so
// unlike those this is a custom `defineChannel` (the same primitive Eve's own
// Twilio channel uses): we own the inbound webhook, its authorization check, and
// the outbound HTTP to LoopMessage's Send API. The channel id is this file's name
// (`imessage`), so Eve mounts the inbound webhook at `/eve/v1/imessage`.
//
// LoopMessage (https://docs.loopmessage.com) is the iMessage bridge — an
// Apple-registered sender delivers and receives real iMessages over HTTP.
// Self-host credentials come from the environment (no Vercel Connect required):
//   LOOPMESSAGE_API_KEY              — Authorization header for the Send API
//                                      (the RAW key value, NOT "Bearer …").
//   LOOPMESSAGE_SENDER_NAME          — the registered sender_name to send from.
//   LOOPMESSAGE_WEBHOOK_SECRET_TOKEN — the value LoopMessage echoes in every
//                                      inbound request's Authorization header
//                                      (the dashboard "webhook_header"); we verify
//                                      it constant-time and 401 on mismatch. Unset
//                                      ⇒ fail closed (all inbound rejected).
//   LOOPMESSAGE_DEFAULT_RECIPIENT    — optional. The run-outcome push (#1100)
//                                      carries no non-secret handle over the wire,
//                                      so an outbound outcome resolves its
//                                      recipient here, Jace-side.
//   LOOPMESSAGE_ALLOWED_HANDLES      — optional. A comma-separated allowlist of
//                                      iMessage senders (1:1 contact handles or
//                                      group ids) permitted to drive a turn. Unset
//                                      ⇒ open (the sandbox already caps to ≤5
//                                      approved contacts); set ⇒ any unlisted
//                                      sender is ACKed and ignored (#1100 AC4).
//
// Two directions, same as the telegram/discord/slack channels:
//  1. INBOUND conversation — the `POST("/eve/v1/imessage")` route verifies the Authorization
//     header, then ACKs 200 within LoopMessage's 15s window and does the model
//     turn under `waitUntil`. LoopMessage retries any non-2xx (up to 30×), so
//     acking fast and deferring the work is what prevents duplicate replies.
//  2. OUTBOUND run-outcome — `receive()` is the cross-channel hand-off target the
//     run-outcome route calls (`args.receive(imessage, …)`); it resolves the
//     recipient and posts the outcome as a repliable thread.
//
// `events["message.completed"]` splits Jace's reply into human-cadence bubbles on
// the model's own paragraph breaks (same pure splitter + Eve-default guard as
// telegram — see agent/lib/chat-split.core.mjs). LoopMessage has no typing
// indicator, so unlike telegram there is no startTyping between bubbles.
//
// All pure request/response shaping + the inbound auth check live in the
// unit-tested agent/lib/loopmessage.core.mjs; this wrapper only holds the Eve
// runtime glue and the one `fetch`. The outbound push stays inert until a
// workspace opts in via `jaceOwnsIMessageNotify` (default OFF); inbound is live
// whenever LoopMessage's webhook is pointed at `/eve/v1/imessage`.
//
// NOTE: `defineChannel`/`POST`/`args.receive` shape follows the eve@0.19.0 docs
// and mirrors Eve's built-in Twilio channel; live delivery is verified against
// the running sidecar (#1038/#1101).
import { defineChannel, POST } from "eve/channels";
import { splitIntoChatMessages } from "../lib/chat-split.core.mjs";
import {
  LOOPMESSAGE_SEND_URL,
  buildSendBody,
  imessageContinuationToken,
  isActionableInbound,
  isAllowedSender,
  loopMessageSendHeaders,
  parseAllowedHandles,
  parseLoopInbound,
  verifyWebhookAuthorization,
} from "../lib/loopmessage.core.mjs";

type IMessageState = { handle: string | null; group: string | null };

const apiKey = (process.env["LOOPMESSAGE_API_KEY"] ?? "").trim();
const senderName = (process.env["LOOPMESSAGE_SENDER_NAME"] ?? "").trim();
const webhookSecret = (process.env["LOOPMESSAGE_WEBHOOK_SECRET_TOKEN"] ?? "").trim();
const defaultRecipient = (process.env["LOOPMESSAGE_DEFAULT_RECIPIENT"] ?? "").trim();
// Jace-side sender allowlist (#1100 AC4). Empty ⇒ open (unrestricted inbound).
const allowedHandles = parseAllowedHandles(process.env["LOOPMESSAGE_ALLOWED_HANDLES"] ?? "");

/** Trim a possibly-undefined value to a string ("" when not a string). */
function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A per-session LoopMessage sender bound to this conversation's target. `post`
 * delivers one iMessage bubble; the credential (LOOPMESSAGE_API_KEY) never leaves
 * Jace's env. Built lazily in `context`, so no network happens until a reply is
 * actually posted.
 */
function buildImessageHandle(state: IMessageState) {
  return {
    async post(text: string): Promise<void> {
      const body = buildSendBody({
        recipient: state.handle ?? undefined,
        group: state.group ?? undefined,
        text,
        senderName,
      });
      const res = await fetch(LOOPMESSAGE_SEND_URL, {
        method: "POST",
        headers: loopMessageSendHeaders(apiKey),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `LoopMessage send failed (${res.status}): ${detail.slice(0, 300)}`,
        );
      }
    },
  };
}

/**
 * A small context block appended (as a user-role message) before the model turn,
 * so Jace knows the medium and cadence — mirrors Eve's Twilio channel context
 * block. Kept terse; the voice/length contract lives in instructions.md.
 */
function formatIMessageContextBlock(state: IMessageState): string {
  const who = state.group
    ? `group: ${state.group}`
    : `contact: ${state.handle ?? "unknown"}`;
  return [
    "<imessage_context>",
    "channel: imessage (LoopMessage bridge)",
    who,
    "response_medium: imessage",
    "Keep replies short and text-like; a blank line starts a new bubble.",
    "</imessage_context>",
  ].join("\n");
}

const initialState: IMessageState = { handle: null, group: null };

export default defineChannel<IMessageState>({
  kindHint: "imessage",
  state: initialState,
  context(state: IMessageState) {
    return { state, imessage: buildImessageHandle(state) };
  },
  routes: [
    // Custom `defineChannel` routes mount at their literal path — Eve does NOT
    // auto-prefix `/eve/v1/<name>` the way framework channels do — so we pass the
    // full absolute webhook path, exactly as Eve's own Twilio channel does
    // (`/eve/v1/twilio`). A bare "/" would mount this webhook at the server root.
    POST("/eve/v1/imessage", async (req, args) => {
      // 1) Authorize. LoopMessage echoes the dashboard webhook_header value in
      //    the Authorization header on EVERY event; verify it constant-time.
      //    Unset secret ⇒ fail closed (verifyWebhookAuthorization returns false).
      const authHeader = req.headers.get("authorization") ?? "";
      if (!verifyWebhookAuthorization(authHeader, webhookSecret)) {
        return new Response("unauthorized", { status: 401 });
      }

      let raw: unknown;
      try {
        raw = await req.json();
      } catch {
        // Malformed body: ACK so LoopMessage does not retry a dead payload.
        return new Response("ok", { status: 200 });
      }

      const inbound = parseLoopInbound(raw);
      // Only real inbound TEXT messages drive a turn. Delivery/scheduled/failed/
      // reaction events and any empty / addressless payload are ACKed + ignored,
      // well within LoopMessage's 15s window.
      if (!isActionableInbound(inbound)) {
        return new Response("ok", { status: 200 });
      }

      // Enforce the Jace-side sender allowlist (#1100 AC4). A valid, authenticated
      // webhook from a sender not on LOOPMESSAGE_ALLOWED_HANDLES is ACKed (so
      // LoopMessage does not retry) but drives no turn. Unset allowlist ⇒ open.
      if (!isAllowedSender(inbound, allowedHandles)) {
        return new Response("ok", { status: 200 });
      }

      const state: IMessageState = {
        handle: inbound.contact || null,
        group: inbound.group,
      };
      const token = imessageContinuationToken(inbound.group ?? inbound.contact);

      // Defer the model turn until AFTER the 200 — LoopMessage retries on any
      // non-2xx, so acking fast + working under waitUntil prevents duplicates.
      args.waitUntil(
        args.send(
          {
            message: inbound.text,
            context: [formatIMessageContextBlock(state)],
          },
          { auth: null, continuationToken: token, state },
        ),
      );

      return new Response("ok", { status: 200 });
    }),
  ],
  async receive(input, { send }) {
    // Cross-channel hand-off target for the run-outcome push (#1050/#1100). The
    // console carries no non-secret iMessage handle over the wire (there is no
    // iMessage "channel id"), so resolve the recipient from the target when
    // present, else fall back to the Jace-side LOOPMESSAGE_DEFAULT_RECIPIENT.
    const handle = readString(input.target?.handle) || defaultRecipient;
    if (!handle) {
      throw new Error(
        "imessage.receive requires target.handle or LOOPMESSAGE_DEFAULT_RECIPIENT.",
      );
    }
    const state: IMessageState = { handle, group: null };
    return send(input.message, {
      auth: input.auth,
      continuationToken: imessageContinuationToken(handle),
      state,
    });
  },
  events: {
    async "message.completed"(data, channel) {
      if (data.finishReason === "tool-calls" || !data.message) return;
      const messages = splitIntoChatMessages(data.message);
      for (const message of messages) {
        // No startTyping between bubbles: LoopMessage exposes no typing signal.
        await channel.imessage.post(message);
      }
    },
  },
});

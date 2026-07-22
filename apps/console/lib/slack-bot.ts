/**
 * The hosted shared Slack app's low-level mechanics (#1285 PR ①) — the Slack
 * analogue of `discord-bot.ts` (#1284) / `connectors/secret/telegram.ts`'s
 * send helpers. NOT placed under `connectors/secret/` — that tree holds the
 * retired per-workspace-token models this shared-app approach replaces.
 *
 * Slack's Events API DOES deliver plain message events over HTTP (unlike
 * Discord, which is Interactions-only) — a DM to the app arrives as an
 * `event_callback` with `event.type === "message"` and
 * `event.channel_type === "im"`. Every event request is verified via the
 * `X-Slack-Signature` / `X-Slack-Request-Timestamp` headers: HMAC-SHA256,
 * keyed by `SLACK_SIGNING_SECRET`, over the basestring `v0:{timestamp}:{raw
 * body}` (Slack's documented "Verifying requests from Slack" recipe).
 */
import { createHmac, timingSafeEqual } from "crypto";

/** Requests older than this are rejected (Slack's documented replay-attack window). */
const MAX_TIMESTAMP_SKEW_SECONDS = 60 * 5;

/**
 * Verify a Slack Events API request's signature. Returns `false` (never
 * throws) on a missing signing secret/header, a stale timestamp (replay
 * protection), or a mismatch. `nowSeconds` is injectable for tests;
 * defaults to the real clock.
 */
export function verifySlackSignature(params: {
  signingSecret: string | undefined;
  signature: string | null;
  timestamp: string | null;
  rawBody: string;
  nowSeconds?: number;
}): boolean {
  const { signingSecret, signature, timestamp, rawBody } = params;
  if (!signingSecret || !signature || !timestamp) return false;
  if (!/^\d+$/.test(timestamp)) return false;

  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > MAX_TIMESTAMP_SKEW_SECONDS) return false;

  const basestring = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", signingSecret).update(basestring).digest("hex")}`;

  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  if (expectedBuf.length !== actualBuf.length) return false;
  try {
    return timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

// --- Web API mechanics (bot token) ------------------------------------------

const SLACK_API_BASE = "https://slack.com/api";
const TIMEOUT_MS = 8000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export type SendResult = { ok: true } | { ok: false; error: string };

/**
 * Post a plain-text message via `chat.postMessage`. Never throws; a
 * transport blip or a Slack-side rejection (Slack's Web API returns HTTP 200
 * with `{ ok: false, error }` on most failures, so BOTH the transport status
 * and the body's own `ok` flag are checked) surfaces as a typed failure.
 */
export async function sendSlackChannelMessage(
  token: string,
  channel: string,
  text: string
): Promise<SendResult> {
  try {
    const res = await fetchWithTimeout(`${SLACK_API_BASE}/chat.postMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ channel, text }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !body?.ok) {
      return {
        ok: false,
        error: `Slack rejected the message${body?.error ? ` (${body.error})` : ""} — make sure the app is a member of that conversation.`,
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't reach Slack to send the message — try again." };
  }
}

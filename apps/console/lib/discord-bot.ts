/**
 * The hosted shared Discord bot's low-level mechanics (#1284 PR ①) — the
 * Discord analogue of `connectors/secret/telegram.ts`'s
 * `sendTelegramMessage`/etc, but deliberately NOT placed under
 * `connectors/secret/` (that tree is the RETIRED per-workspace-token Discord
 * model — `connectors/secret/discord.ts` + `connectors/discord/route.ts` —
 * which this file must not extend; see the #1284 issue brief's "AVOID
 * list"). This is the shared bot's OWN mechanics, keyed by env credentials,
 * mirroring the Telegram hosted-bot pattern from #1262.
 *
 * Discord's inbound HTTP contract is fundamentally different from Telegram's:
 * Discord does not deliver plain DM text over a webhook at all — only
 * INTERACTIONS (slash commands, message components), verified via an Ed25519
 * signature over `timestamp + rawBody` (Discord's documented
 * "Validating Security Request Headers", developers/interactions/overview).
 * A stranger "DMs the bot" in v1 by invoking the bot's registered slash
 * command in a DM with it — Discord explicitly supports bot-DM-context
 * commands (`InteractionContextType.BOT_DM`) — which arrives as a normal
 * APPLICATION_COMMAND interaction, HTTP-only, no Gateway websocket required.
 * This keeps the console's inbound door stateless/serverless, matching every
 * other channel's webhook shape; command REGISTRATION itself (POST
 * /applications/{id}/commands) is a one-time ops step alongside minting the
 * bot token (see the PR body's deploy runbook note).
 *
 * Verification uses Node's built-in `crypto.verify` with the raw 32-byte
 * Ed25519 public key wrapped in its fixed SPKI DER prefix — no new dependency
 * (e.g. tweetnacl) needed; Node has supported Ed25519 verification natively
 * since v12.
 */
import { createPublicKey, verify as cryptoVerify } from "crypto";

/** The fixed 12-byte SPKI/DER prefix for a raw 32-byte Ed25519 public key (RFC 8410). Constant for every key; only the 32 key bytes vary. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Verify a Discord Interactions Endpoint request's Ed25519 signature
 * (`X-Signature-Ed25519` over `X-Signature-Timestamp + rawBody`), per
 * Discord's documented verification recipe. Returns `false` (never throws)
 * on a missing/malformed key, signature, or timestamp, or on any
 * verification failure — the caller fails closed on any `false`.
 */
export function verifyDiscordSignature(params: {
  publicKeyHex: string;
  signatureHex: string;
  timestamp: string;
  rawBody: string;
}): boolean {
  const { publicKeyHex, signatureHex, timestamp, rawBody } = params;
  if (!publicKeyHex || !signatureHex || !timestamp) return false;
  try {
    const keyBytes = Buffer.from(publicKeyHex, "hex");
    if (keyBytes.length !== 32) return false;
    const signatureBytes = Buffer.from(signatureHex, "hex");
    if (signatureBytes.length !== 64) return false;
    const keyObject = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, keyBytes]),
      format: "der",
      type: "spki",
    });
    return cryptoVerify(
      null,
      Buffer.from(timestamp + rawBody, "utf8"),
      keyObject,
      signatureBytes
    );
  } catch {
    return false;
  }
}

// --- REST mechanics (bot token) ---------------------------------------------

const DISCORD_API_BASE = "https://discord.com/api/v10";
const TIMEOUT_MS = 8000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit
): Promise<Response> {
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
 * Post a plain-text message to a channel via the Bot API
 * (`POST /channels/{channelId}/messages`, `Authorization: Bot <token>`).
 * Never throws; a transport blip or a Discord-side rejection surfaces as a
 * typed failure, mirroring `sendTelegramMessage`'s contract.
 */
export async function sendDiscordChannelMessage(
  token: string,
  channelId: string,
  text: string
): Promise<SendResult> {
  try {
    const res = await fetchWithTimeout(
      `${DISCORD_API_BASE}/channels/${encodeURIComponent(channelId)}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bot ${token}`,
        },
        body: JSON.stringify({ content: text }),
      }
    );
    if (!res.ok) {
      return {
        ok: false,
        error: `Discord rejected the message (status ${res.status}) — make sure the bot has access to that channel.`,
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't reach Discord to send the message — try again." };
  }
}

/** Discord interaction response types this door uses (a small, deliberate subset). */
export const DISCORD_INTERACTION_RESPONSE = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
} as const;

/** Discord interaction types this door recognizes. */
export const DISCORD_INTERACTION_TYPE = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
} as const;

/**
 * Telegram inbound-webhook secret ROTATION (#1031, server-only).
 *
 * The per-workspace `webhookSecret` (config, #889) is a shared nonce Telegram
 * echoes in `X-Telegram-Bot-Api-Secret-Token` on every delivery so the inbound
 * route can authenticate the request. If it ever leaks (or on a routine
 * schedule) we need to swap it without re-collecting the bot token.
 *
 * `rotateTelegramWebhookSecret` mirrors the connect-time machinery in
 * `connectors/secret/route.ts` exactly:
 *   1. generate a fresh secret (`randomBytes(32).toString("hex")`),
 *   2. re-register the webhook with Telegram via the existing `setTelegramWebhook`
 *      (`secret_token` = the new secret), and
 *   3. persist the new secret into the connector's readable jsonb `config`.
 *
 * It reuses the stored bot token (read via `getConnectorSecret`) — the encrypted
 * write-only credential is never touched, and `upsertConnector` merges `config`
 * key-by-key so chatId / offset survive the rotation.
 *
 * BEST-EFFORT by contract, exactly like connect: a `setWebhook` failure, an unset
 * public base URL, or a transport blip is surfaced as a typed result — it NEVER
 * throws. On any failure the stored secret is left untouched (we never persist a
 * secret Telegram won't actually echo), so the inbound path keeps working with
 * the old secret rather than being half-rotated into a broken state.
 */

import { randomBytes } from "crypto";
import {
  getConnector,
  getConnectorSecret,
  upsertConnector,
} from "@agentrail/db-postgres";
import { setTelegramWebhook } from "./telegram";

/**
 * Public base URL of this AgentRail server — the host Telegram must reach to POST
 * inbound updates. Kept identical to the connect route's `publicBaseUrl()` so the
 * rotated webhook URL matches the one registered at connect. Returns "" when unset
 * (typical on localhost) so rotation degrades gracefully rather than registering a
 * broken `undefined/...` URL.
 */
function publicBaseUrl(): string {
  const raw =
    process.env["AGENTRAIL_SERVER_BASE_URL"] ||
    process.env["NEXTAUTH_URL"] ||
    (process.env["VERCEL_URL"] ? `https://${process.env["VERCEL_URL"]}` : "");
  return raw.replace(/\/+$/, "");
}

export type RotateResult =
  | { ok: true; secretRotated: true }
  | { ok: false; error: string };

/**
 * Rotate the per-workspace Telegram inbound webhook secret and re-register the
 * webhook. Best-effort: returns a typed result, never throws. On success the new
 * secret is persisted to `config.webhookSecret`; on any failure the stored config
 * is left unchanged.
 */
export async function rotateTelegramWebhookSecret(
  workspaceId: string
): Promise<RotateResult> {
  try {
    // The connector must be connected (enabled + bot token stored) to rotate —
    // there's nothing to re-register otherwise.
    const connector = await getConnector(workspaceId, "telegram");
    if (!connector || !connector.enabled) {
      return { ok: false, error: "Telegram is not connected for this workspace." };
    }
    const token = await getConnectorSecret(workspaceId, "telegram");
    if (!token) {
      return { ok: false, error: "Telegram is not connected for this workspace." };
    }

    // A public base URL is required: rotation only makes sense on the deployed
    // (webhook) path. On localhost (no base) the inbound driver is polling, which
    // doesn't use a webhook secret — nothing to rotate.
    const base = publicBaseUrl();
    if (!base) {
      return {
        ok: false,
        error:
          "AGENTRAIL_SERVER_BASE_URL is unset — the webhook secret is only used on the deployed webhook path (local inbound uses polling), so there is nothing to rotate.",
      };
    }

    // Generate + re-register FIRST, persist only on success — mirrors connect,
    // where a failed setWebhook drops the secret rather than storing one Telegram
    // won't echo. This keeps the old secret working if re-registration fails.
    const newSecret = randomBytes(32).toString("hex");
    const webhookUrl = `${base}/api/v1/connectors/telegram/webhook/${workspaceId}`;
    const registered = await setTelegramWebhook(token, webhookUrl, newSecret);
    if (!registered.ok) {
      return { ok: false, error: registered.error };
    }

    // Persist only the new secret. upsertConnector merges config key-by-key
    // (preserving chatId / triggerLabel / offset) and never touches the encrypted
    // bot-token column — so this rewrites just webhookSecret.
    await upsertConnector(workspaceId, "telegram", {
      config: { webhookSecret: newSecret },
    });

    return { ok: true, secretRotated: true };
  } catch {
    // Best-effort, exactly like connect: never throw out of rotation.
    return {
      ok: false,
      error: "Couldn't rotate the Telegram webhook secret — try again.",
    };
  }
}

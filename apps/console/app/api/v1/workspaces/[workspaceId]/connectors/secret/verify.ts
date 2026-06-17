import type { ConnectorKind } from "../../../../../../../app/(dashboard)/dashboard/[workspaceId]/connectors/components/connector-helpers";

/**
 * Live credential verification (server-only) — "don't save a wrong key".
 *
 * Format validation (connector-helpers) is the cheap first gate; this is the real
 * one: it calls the provider with the supplied credential and only lets a key
 * through if the provider actually accepts it. A clear auth rejection (the key is
 * wrong) is reported back to the user; a transient network failure is also
 * rejected (we never store an unverified credential) with a retry hint.
 *
 * Verified live: Linear (GraphQL `viewer`), Figma (`/v1/me`), Telegram (`getMe`
 * + `getChat`). Context7 / Slack stay format-only here — Context7 has no
 * stable side-effect-free check and a Slack webhook can't be probed without
 * posting to the channel; their format gate already rejects malformed values.
 */

export type VerifyResult = { ok: true } | { ok: false; error: string };

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

/** Linear: a valid personal API key resolves `viewer` over GraphQL. */
async function verifyLinear(key: string): Promise<VerifyResult> {
  try {
    const res = await fetchWithTimeout("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: key },
      body: JSON.stringify({ query: "{ viewer { id } }" }),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Linear rejected this API key." };
    }
    if (!res.ok) {
      return { ok: false, error: `Couldn't verify with Linear (HTTP ${res.status}).` };
    }
    const body = (await res.json().catch(() => ({}))) as {
      data?: { viewer?: { id?: string } };
      errors?: unknown;
    };
    if (body?.data?.viewer?.id) return { ok: true };
    return { ok: false, error: "Linear rejected this API key." };
  } catch {
    return { ok: false, error: "Couldn't reach Linear to verify the key — try again." };
  }
}

/** Figma: a valid token resolves the current user via `/v1/me`. */
async function verifyFigma(token: string): Promise<VerifyResult> {
  try {
    const res = await fetchWithTimeout("https://api.figma.com/v1/me", {
      headers: { "X-Figma-Token": token },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Figma rejected this access token." };
    }
    if (!res.ok) {
      return { ok: false, error: `Couldn't verify with Figma (HTTP ${res.status}).` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't reach Figma to verify the token — try again." };
  }
}

/** Telegram: the token must resolve `getMe`, and the bot must see the chat. */
async function verifyTelegram(token: string, chatId?: string): Promise<VerifyResult> {
  try {
    const me = await fetchWithTimeout(
      `https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`,
      { method: "GET" }
    );
    const meBody = (await me.json().catch(() => ({}))) as { ok?: boolean };
    if (!meBody?.ok) {
      return { ok: false, error: "Telegram rejected this bot token." };
    }
    if (chatId) {
      const chat = await fetchWithTimeout(
        `https://api.telegram.org/bot${encodeURIComponent(
          token
        )}/getChat?chat_id=${encodeURIComponent(chatId)}`,
        { method: "GET" }
      );
      const chatBody = (await chat.json().catch(() => ({}))) as {
        ok?: boolean;
        description?: string;
      };
      if (!chatBody?.ok) {
        return {
          ok: false,
          error:
            "The bot can't see that chat — add the bot to the chat/channel, then retry.",
        };
      }
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: "Couldn't reach Telegram to verify the bot — try again.",
    };
  }
}

/**
 * Verify a credential against its provider. Returns `{ok:true}` only when the
 * provider accepts it. Providers without a safe live check (context7, slack)
 * return `{ok:true}` here — their format gate is the guarantee.
 */
export async function verifyConnectorCredential(
  kind: ConnectorKind,
  secret: string,
  chatId?: string
): Promise<VerifyResult> {
  switch (kind) {
    case "linear":
      return verifyLinear(secret.trim());
    case "figma":
      return verifyFigma(secret.trim());
    case "telegram":
      return verifyTelegram(secret.trim(), chatId?.trim());
    case "context7":
    case "slack":
      // Format-only (no safe side-effect-free live probe); already gated upstream.
      return { ok: true };
    default:
      return { ok: true };
  }
}

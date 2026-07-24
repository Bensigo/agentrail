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
 * Verified live: Linear (GraphQL `viewer`), Figma (`/v1/me`). Context7 stays
 * format-only here — it has no stable side-effect-free check; its format gate
 * already rejects malformed values. Discord/Slack/Telegram are no longer
 * credential-based (Gateway → Channels cutover): `secret/route.ts`'s allowlist
 * rejects them before a call ever reaches this module. The `default` case
 * below still answers `{ok:true}` for them so this function stays total over
 * every `ConnectorKind`, but that path is unreachable through the route today.
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

/**
 * Verify a credential against its provider. Returns `{ok:true}` only when the
 * provider accepts it. Context7 has no safe live check, so it returns
 * `{ok:true}` here — its format gate is the guarantee.
 */
export async function verifyConnectorCredential(
  kind: ConnectorKind,
  secret: string
): Promise<VerifyResult> {
  switch (kind) {
    case "linear":
      return verifyLinear(secret.trim());
    case "figma":
      return verifyFigma(secret.trim());
    case "context7":
      // Format-only (no safe side-effect-free live probe); already gated upstream.
      return { ok: true };
    default:
      // github (oauth) and the channel kinds (discord/slack/telegram — no
      // longer credential-based) never legitimately reach this function
      // through the route's allowlist; total and harmless if they ever do.
      return { ok: true };
  }
}

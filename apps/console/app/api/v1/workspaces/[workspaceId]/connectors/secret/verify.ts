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
 * Verified live: Linear (GraphQL `viewer`), Figma (`/v1/me`), Railway (Task 7
 * — GraphQL `me`). Context7 stays format-only here — it has no stable
 * side-effect-free check; its format gate already rejects malformed values.
 * Discord/Slack/Telegram are no longer credential-based (Gateway → Channels
 * cutover): `secret/route.ts`'s allowlist rejects them before a call ever
 * reaches this module. The `default` case below still answers `{ok:true}`
 * for them so this function stays total over every `ConnectorKind`, but that
 * path is unreachable through the route today.
 *
 * RAILWAY (Task 7): confirmed against Railway's public API docs
 * (https://docs.railway.com/integrations/api,
 * https://docs.railway.com/reference/public-api — both fetched during
 * implementation) rather than trusted from memory, per the task's mandatory
 * first step:
 *   - Endpoint: `POST https://backboard.railway.com/graphql/v2`.
 *   - Auth: `Authorization: Bearer <token>`.
 *   - The docs' own canonical minimal verification query is
 *     `query { me { name email } }` — NOT `query { me { id } }`. Both fetched
 *     pages show the exact same worked example, and Railway also states this
 *     query "cannot be used with a workspace or project token because the
 *     data returned is scoped to your personal account" (a caveat worth
 *     keeping in mind if a future Team-scoped-only token ever fails this
 *     check). Docs govern over the originally-assumed `{ id }` shape.
 *   - A GraphQL error body (`{"errors":[...]}`, HTTP 200) is treated as
 *     rejection — Railway, like most GraphQL servers, does not always signal
 *     an invalid-token query with a non-2xx status.
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

const RAILWAY_GRAPHQL_ENDPOINT = "https://backboard.railway.com/graphql/v2";

/** Railway: a valid Account/Team token resolves `me` over GraphQL — see this
 * module's own doc-comment ("RAILWAY (Task 7)") for the doc-confirmed query
 * shape and why `{ name email }`, not the originally-assumed `{ id }`. */
async function verifyRailway(token: string): Promise<VerifyResult> {
  try {
    const res = await fetchWithTimeout(RAILWAY_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: "query { me { name email } }" }),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Railway rejected this token." };
    }
    if (!res.ok) {
      return { ok: false, error: `Couldn't verify with Railway (HTTP ${res.status}).` };
    }
    const body = (await res.json().catch(() => ({}))) as {
      data?: { me?: { name?: string; email?: string } };
      errors?: unknown;
    };
    // A GraphQL error body rides on HTTP 200 — treated as rejection (see
    // this module's own doc-comment). A valid token resolves at least one
    // of the two requested scalar fields.
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      return { ok: false, error: "Railway rejected this token." };
    }
    if (body?.data?.me?.email || body?.data?.me?.name) return { ok: true };
    return { ok: false, error: "Railway rejected this token." };
  } catch {
    return { ok: false, error: "Couldn't reach Railway to verify the token — try again." };
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
    case "railway":
      return verifyRailway(secret.trim());
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

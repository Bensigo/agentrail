import {
  getConnectorSecret,
  setConnectorSecret,
  parseSecretEnvelope,
  serializeOauthEnvelope,
  type ConnectorProvider,
} from "@agentrail/db-postgres";
import { oauthAdapterFor, type OauthEnvelope } from "./types";

/**
 * `provider` is a plain `string` on every export below (not the stricter
 * `ConnectorProvider`), matching `OauthProviderAdapter.provider`'s own
 * looseness (`types.ts`'s own doc-comment) and `lib/evidence/registry.ts`'s
 * identical precedent — this file never has to widen its own public surface
 * just because ITS internals happen to call two `@agentrail/db-postgres`
 * functions that want the stricter type; the cast lives at that one
 * boundary instead (`asConnectorProvider` below). A real call site (a T2/T3
 * evidence adapter) always passes a genuine `ConnectorProvider` literal
 * regardless.
 */
function asConnectorProvider(provider: string): ConnectorProvider {
  return provider as ConnectorProvider;
}

/**
 * OAuth Connect Wave 3, W3-T1 (`.superpowers/sdd/plan-oauth.md`) —
 * `resolveProviderAuth`, the shared helper an evidence adapter calls
 * INSTEAD of reading `connectors.secret` directly (W3-T2 switches
 * `lib/evidence/railway.ts` over; W3-T3 switches `sentry.ts` — this file
 * ships the helper now so both tasks are a swap-in, not a redesign).
 *
 * CONTRACT (pinned by the plan's Global Constraints, "Refresh"):
 * decrypt → discriminate the envelope → if it's a legacy token, return it
 * verbatim (the fallback-forever path — no refresh concept applies) → if
 * it's an OAuth envelope and `expiresAt` is within a 2-minute skew of now,
 * refresh via the provider's registered adapter, persist the ROTATED
 * envelope, and return the new access token → otherwise return the current
 * access token unchanged. NEVER throws: every failure (nothing stored, a
 * corrupted secret, no registered adapter, the adapter's own `refresh()`
 * rejecting) degrades to a typed, closed result — a caller building an
 * evidence query treats `{ ok: false, reason: "unauthorized" }` exactly like
 * today's "the provider rejected the credential" case (operator reconnects),
 * and `{ ok: false, reason: "config_missing" }` exactly like today's "no
 * credential stored at all" case — both reasons already exist in
 * `lib/evidence/types.ts`'s `EvidenceDegradationReason` closed set, so W3-T2/T3
 * wire this straight through with no new degradation vocabulary.
 *
 * SINGLE-FLIGHT: console runs as ONE replica (documented, pinned) — an
 * in-process `Map<"workspaceId:provider", Promise<...>>` is therefore a
 * correct, sufficient dedupe: concurrent callers for the SAME
 * (workspaceId, provider) within the same refresh window share the ONE
 * in-flight `adapter.refresh()` call and its one `setConnectorSecret` write,
 * rather than each independently racing the vendor's refresh endpoint
 * (several vendors — Railway included, per the plan's verified vendor facts
 * — ROTATE the refresh token on use, so a second, redundant refresh call
 * would invalidate the first caller's freshly-rotated token). The map entry
 * is removed once the attempt settles (success OR failure), so the NEXT
 * call — whether moments later or on the next request — always starts a
 * fresh attempt rather than being stuck behind a resolved promise.
 */

const REFRESH_SKEW_MS = 2 * 60 * 1000;

export type ResolveProviderAuthResult =
  | { ok: true; secret: string }
  | { ok: false; reason: "config_missing" | "unauthorized" };

/** Whether an OAuth credential is expired or within the refresh skew.
 * Fails TOWARD refreshing on an unparseable `expiresAt` (never trusts a
 * garbage timestamp as "still valid"). */
function needsRefresh(credential: OauthEnvelope): boolean {
  const expiresAtMs = new Date(credential.expiresAt).getTime();
  if (!Number.isFinite(expiresAtMs)) return true;
  return expiresAtMs - Date.now() <= REFRESH_SKEW_MS;
}

type RefreshOutcome = { ok: true; access: string } | { ok: false };

const inFlightRefreshes = new Map<string, Promise<RefreshOutcome>>();

/** The single-flight refresh attempt for one (workspaceId, provider). See
 * this file's own doc-comment ("SINGLE-FLIGHT") for the full reasoning. */
function refreshSingleFlight(
  workspaceId: string,
  provider: string,
  credential: OauthEnvelope
): Promise<RefreshOutcome> {
  const key = `${workspaceId}:${provider}`;
  const existing = inFlightRefreshes.get(key);
  if (existing) return existing;

  const attempt: Promise<RefreshOutcome> = (async () => {
    const adapter = oauthAdapterFor(provider);
    if (!adapter) return { ok: false };
    try {
      const rotated = await adapter.refresh(credential);
      await setConnectorSecret(workspaceId, asConnectorProvider(provider), serializeOauthEnvelope(rotated));
      return { ok: true, access: rotated.access };
    } catch {
      return { ok: false };
    }
  })();

  inFlightRefreshes.set(key, attempt);
  // Cleanup runs regardless of outcome so the NEXT call (success or failure)
  // always starts fresh rather than reusing a settled promise.
  void attempt.finally(() => {
    if (inFlightRefreshes.get(key) === attempt) inFlightRefreshes.delete(key);
  });
  return attempt;
}

/**
 * Resolve the bearer-ready credential for (workspaceId, provider). See this
 * file's own doc-comment for the full contract. `secret` on success is
 * whatever an evidence adapter already sends as
 * `Authorization: Bearer <secret>` today — a legacy token, verbatim, or a
 * (possibly just-refreshed) OAuth access token; the caller never needs to
 * know which.
 */
export async function resolveProviderAuth(
  workspaceId: string,
  provider: string
): Promise<ResolveProviderAuthResult> {
  let plaintext: string | null;
  try {
    plaintext = await getConnectorSecret(workspaceId, asConnectorProvider(provider));
  } catch {
    // A stored-but-corrupted secret (tampered ciphertext, wrong
    // CONNECTOR_SECRET_KEY) — same operator remedy as a rejected refresh:
    // reconnect the connector.
    return { ok: false, reason: "unauthorized" };
  }
  if (!plaintext) return { ok: false, reason: "config_missing" };

  const parsed = parseSecretEnvelope(plaintext);
  if (parsed.kind === "token") {
    return { ok: true, secret: parsed.value };
  }

  if (!needsRefresh(parsed.credential)) {
    return { ok: true, secret: parsed.credential.access };
  }

  const refreshed = await refreshSingleFlight(workspaceId, provider, parsed.credential);
  if (!refreshed.ok) return { ok: false, reason: "unauthorized" };
  return { ok: true, secret: refreshed.access };
}

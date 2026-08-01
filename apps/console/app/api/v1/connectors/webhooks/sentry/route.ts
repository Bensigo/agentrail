import { NextRequest, NextResponse } from "next/server";
import {
  clearSentryConnectorForInstallation,
  findConnectorsBySentryInstallationId,
} from "@agentrail/db-postgres";
import {
  SENTRY_INSTALLATION_ACTION_DELETED,
  SENTRY_INSTALLATION_RESOURCE,
  SENTRY_WEBHOOK_RESOURCE_HEADER,
  SENTRY_WEBHOOK_SIGNATURE_HEADER,
  parseSentryWebhookPayload,
  sanitizeForLog,
  verifySentryWebhookSignature,
} from "./sentry-webhook-helpers";

/**
 * Sentry integration webhook receiver (W3-T5, unplanned fast-follow off the
 * merged OAuth Connect Wave 3 — see `.superpowers/sdd/plan-oauth.md`'s
 * Global Constraints and `task-W3T3-report.md` for the as-built Sentry
 * OAuth flow this sits alongside). Sentry's Public Integration platform
 * (`lib/oauth/sentry.ts`, W3-T3) POSTs installation lifecycle events here —
 * `https://www.heyjace.com/api/v1/connectors/webhooks/sentry` is the exact
 * production Webhook URL registered on the integration (see
 * `docs/superpowers/specs/2026-07-31-oauth-connect-design.md`'s "Owner
 * registration steps"). This route's ONLY functional job today is
 * `installation.deleted`: when a workspace's owner uninstalls the
 * integration FROM SENTRY'S OWN side (Sentry's UI, not this console's
 * disconnect button), this webhook is the ONLY signal that ever reaches
 * us — without it, a disconnected-at-the-vendor connector would sit in
 * this console forever looking "connected" (`hasSecret: true`) while every
 * actual API call silently degrades to `unauthorized`.
 *
 * See `./sentry-webhook-helpers.ts` for the full doc-verification trail
 * (raw-fetched this task) and every parsing/signature helper — this file
 * stays a thin request/response shell, exporting ONLY its HTTP handler
 * (this codebase's `route.ts`-exports-handlers-only convention; mirrors
 * `published-helpers.ts`, `digest-helpers.ts`,
 * `workspaces/[workspaceId]/connectors/secret/verify.ts`).
 *
 * ENV UNSET -> 503, NEVER A SIGNATURE BYPASS: mirrors
 * `billing/stripe/webhook/route.ts`'s identical "not configured" gate. An
 * absent secret must never be treated as "skip verification" — deliberately
 * NOT mirroring `connectors/github/webhook/route.ts`'s legacy `!secret ->
 * true` local-dev convenience: that route's secret is workspace-owned and
 * optional BY DESIGN (an operator may not have wired up a GitHub webhook
 * secret yet); this route's secret is a single global credential shared
 * with the already-live OAuth flow — if it's truly unset, the whole Sentry
 * OAuth feature isn't configured on this deployment, so "verification is
 * optional" would be actively wrong, not just permissive.
 *
 * SIGNATURE FIRST, ALWAYS — the raw body is read BEFORE any `JSON.parse`
 * (the signature is over raw bytes; see sentry-webhook-helpers.ts's own
 * doc-comment, "SIGNATURE"), mirroring `connectors/github/webhook/route.ts`
 * and `billing/stripe/webhook/route.ts`'s identical ordering. `secret` is
 * `SENTRY_OAUTH_CLIENT_SECRET` — the SAME env var W3-T3's OAuth token
 * exchange already reads (a Sentry Public Integration has exactly one
 * Client Secret, used for both purposes) — read directly here rather than
 * through `lib/oauth/types.ts`'s `oauthConfigFor("sentry")` (which
 * additionally requires `SENTRY_OAUTH_CLIENT_ID`, irrelevant to webhook
 * signing) or `envReady()` (which additionally requires
 * `SENTRY_OAUTH_INTEGRATION_SLUG`, also irrelevant here).
 *
 * 200 FOR EVERY VERIFIED EVENT (Sentry's own docs document only a
 * 1-second response-time requirement, not an explicit retry-on-non-2xx
 * policy — see sentry-webhook-helpers.ts's own doc-comment, "RESPONSE" —
 * so this is a defensive default, matching
 * `billing/stripe/webhook/route.ts`'s identical "recognized-but-ignored ->
 * 200" convention, not a vendor requirement): only a BAD/MISSING SIGNATURE
 * (401) or an env-not-configured deployment (503) ever reject a request.
 * DISCLOSED JUDGMENT CALL (this task's own instruction: "200-or-4xx per
 * your judgment, document the choice"): a verified request whose body
 * doesn't even parse as JSON gets 400 — never 200 (nothing to act on but
 * also nothing to silently swallow) and never 500 (a parse failure is not
 * a server error). This reuses `connectors/github/webhook/route.ts`'s own
 * existing precedent for the identical situation (signature already
 * checked out, body still unusable: `{ error: "invalid json" }` / 400)
 * rather than inventing a new convention for the same case.
 *
 * `installation.deleted` (doc-confirmed resource header `installation` +
 * action `deleted` — see sentry-webhook-helpers.ts): resolves every
 * workspace whose `sentry` connector config carries the payload's
 * installation uuid (`findConnectorsBySentryInstallationId` —
 * cross-workspace by construction; an installationId is not itself
 * workspace-scoped information the way every other route's `workspaceId`
 * path/body param is) and clears EACH ONE
 * (`clearSentryConnectorForInstallation`, whose own WHERE re-checks both
 * workspaceId AND installationId — house "guard the write's own WHERE"
 * doctrine, not just a snapshot from this lookup). Ordinarily exactly one
 * match, but this loop is correct for zero (already cleared / unknown
 * installation — benign no-op) or, defensively, more than one.
 * `installation.created` and every OTHER verified resource/action: 200,
 * one log line, no other effect — this console's own token acquisition
 * rides the OAuth redirect flow
 * (`connectors/oauth/callback/[provider]/route.ts`), never this webhook.
 *
 * LOGGING: every log line names `provider`/`workspaceId`, or the bare
 * resource/action labels (a small closed vendor vocabulary, not secret
 * material) — NEVER the signature header value, the raw body, or any other
 * payload field. Matches this codebase's established "log what happened,
 * never the secret material" discipline (`lib/oauth/core.ts`,
 * `lib/oauth/sentry.ts`'s own `verifyInstallBestEffort`).
 */

const SENTRY_WEBHOOK_SECRET_ENV_VAR = "SENTRY_OAUTH_CLIENT_SECRET";

function jsonResponse(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const secret = process.env[SENTRY_WEBHOOK_SECRET_ENV_VAR];
  if (!secret) {
    console.error(
      `[connectors/webhooks/sentry] ${SENTRY_WEBHOOK_SECRET_ENV_VAR} is not configured — rejecting webhook delivery`
    );
    return jsonResponse({ error: "sentry webhook not configured" }, 503);
  }

  // Raw text FIRST — the signature is computed over the untouched request
  // bytes, before any JSON.parse (see sentry-webhook-helpers.ts's own
  // doc-comment, "SIGNATURE").
  const raw = await request.text();
  const signatureHeader = request.headers.get(SENTRY_WEBHOOK_SIGNATURE_HEADER);

  if (!verifySentryWebhookSignature(raw, signatureHeader, secret)) {
    // Never logs the header value or the body — only the bare fact of a
    // mismatch (task-binding: "log WITHOUT echoing header contents or body").
    console.error("[connectors/webhooks/sentry] invalid or missing signature");
    return jsonResponse({ error: "invalid signature" }, 401);
  }

  const payload = parseSentryWebhookPayload(raw);
  if (!payload) {
    console.error("[connectors/webhooks/sentry] verified request body is not valid JSON");
    return jsonResponse({ error: "invalid json" }, 400);
  }

  const resourceHeader = request.headers.get(SENTRY_WEBHOOK_RESOURCE_HEADER);
  const isInstallationDeleted =
    resourceHeader === SENTRY_INSTALLATION_RESOURCE && payload.action === SENTRY_INSTALLATION_ACTION_DELETED;

  if (!isInstallationDeleted) {
    // installation.created and every other verified resource/action —
    // token acquisition rides the OAuth redirect flow, never this webhook.
    // Review W3-T5 LOW-1: both values are attacker-influenced (a signed
    // caller controls them) — sanitized before interpolation so a signed
    // caller still can't forge multi-line log records.
    console.log(
      `[connectors/webhooks/sentry] verified event, no-op (resource=${sanitizeForLog(resourceHeader)}, action=${sanitizeForLog(payload.action)})`
    );
    return jsonResponse({ received: true, status: "ignored" }, 200);
  }

  if (!payload.installationId) {
    // A well-formed, correctly-signed installation.deleted delivery should
    // always carry its own uuid (doc-confirmed) — this is an anomaly, not
    // the expected shape, but still nothing this route can act on: 200,
    // never a retry-inviting error status for a shape problem retrying
    // can't fix.
    console.error(
      "[connectors/webhooks/sentry] installation.deleted delivery missing installation.uuid — nothing to clear"
    );
    return jsonResponse({ received: true, status: "ignored:missing_installation_id" }, 200);
  }

  const matches = await findConnectorsBySentryInstallationId(payload.installationId);
  let cleared = 0;
  for (const match of matches) {
    const ok = await clearSentryConnectorForInstallation(match.workspaceId, payload.installationId);
    if (ok) {
      cleared += 1;
      console.log(
        `[connectors/webhooks/sentry] installation.deleted: cleared sentry connector (workspaceId=${match.workspaceId})`
      );
    }
  }

  return jsonResponse({ received: true, status: "installation_deleted", cleared }, 200);
}

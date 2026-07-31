import { createHmac, randomBytes, timingSafeEqual } from "crypto";

/**
 * Pure Slack OAuth install/callback mechanics (spec §2, §5:
 * docs/superpowers/specs/2026-07-29-slack-multi-workspace-design.md), split
 * out from the two `route.ts` handlers so authorize-URL construction, CSRF
 * `state` sign/verify, and Slack's `oauth.v2.access` response
 * validation/normalization are all unit-testable with no HTTP, no NextRequest,
 * and no database (same idiom as `slack-bot.ts`'s `verifySlackSignature`:
 * pure HMAC in/out, the route owns the network call).
 *
 * `state` signing key: this deploy provisions exactly `SLACK_CLIENT_ID`,
 * `SLACK_CLIENT_SECRET`, and `SLACK_SIGNING_SECRET` for Slack (see
 * deploy/.env.production.example) — no dedicated `SLACK_OAUTH_STATE_SECRET`
 * exists, and minting a fourth secret purely to sign a short-lived CSRF
 * token is unnecessary surface. `SLACK_CLIENT_SECRET` is reused as the HMAC
 * key: it never leaves the server (same trust boundary as the token
 * exchange that already uses it), and `SLACK_SIGNING_SECRET` is deliberately
 * left alone because it verifies a DIFFERENT thing (Slack's own inbound
 * Events API requests) — conflating the two would make rotating one secret
 * silently invalidate the other's guarantee.
 */

// Bot scopes MUST match the Slack app manifest exactly (task 2 brief) — do
// not add or drop any without updating the manifest first.
export const SLACK_BOT_SCOPES = [
  "chat:write",
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
] as const;

export const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
export const SLACK_OAUTH_ACCESS_URL = "https://slack.com/api/oauth.v2.access";

// The registered OAuth redirect — already configured on the Slack app side,
// so this path must never drift from what install/route.ts and
// callback/route.ts actually live at.
export const SLACK_CALLBACK_PATH = "/api/v1/connectors/slack/callback";

// Long enough for a human to land on slack.com's authorize screen, decide,
// and get redirected back; short enough that a state value someone
// glimpses in a browser history entry or a proxy log is worthless within
// minutes.
const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_NONCE_BYTES = 16;

/** Build the redirect_uri Slack sends the browser back to, from the
 * console's own public base URL (`CONSOLE_PUBLIC_URL`, same env var
 * `channel-dispatch.ts`'s `resolveConsolePublicUrl` reads for `/connect`
 * links) — trims whitespace and any trailing slash(es) so a copy-pasted env
 * value with or without a trailing `/` produces the identical URL. */
export function buildSlackRedirectUri(consolePublicUrl: string): string {
  const base = consolePublicUrl.trim().replace(/\/+$/, "");
  return `${base}${SLACK_CALLBACK_PATH}`;
}

export interface BuildSlackAuthorizeUrlInput {
  clientId: string;
  redirectUri: string;
  state: string;
}

/** Build the full `https://slack.com/oauth/v2/authorize` URL the install
 * route 302s to. Pure string/URL construction — no env reads, no network. */
export function buildSlackAuthorizeUrl(input: BuildSlackAuthorizeUrlInput): string {
  const url = new URL(SLACK_AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  return url.toString();
}

/**
 * Mint a signed, expiring CSRF `state`: `base64url(json payload).base64url(hmac)`.
 * Stateless (no DB row, unlike the GitHub install flow's
 * `consumeGithubInstallState`) — there is no workspace to bind yet at this
 * point in the Slack flow (an install can start before any AgentRail
 * workspace exists, spec §1), so there is nothing to look up server-side;
 * the token carries its own expiry and authenticity.
 */
export function signSlackOauthState(secret: string, opts: { now?: number } = {}): string {
  const now = opts.now ?? Date.now();
  const payload = {
    n: randomBytes(STATE_NONCE_BYTES).toString("hex"),
    exp: now + STATE_TTL_MS,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${sig}`;
}

/**
 * Verify a `state` token: well-formed shape, valid HMAC (constant-time
 * compare, same fail-closed idiom as `fleet-auth.ts`'s `verifyFleetBearer`
 * and `jace-console-auth.ts`'s `requireJaceConsoleSecret`), and not expired.
 * Returns a plain boolean — the callback route rejects on `false` without
 * ever explaining which check failed, so a forged token gets no oracle to
 * iterate against. Never throws.
 */
export function verifySlackOauthState(
  secret: string,
  token: string | null | undefined,
  opts: { now?: number } = {}
): boolean {
  if (!secret || !token) return false;

  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payloadB64, sig] = parts;
  if (!payloadB64 || !sig) return false;

  const expectedSig = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  const expectedBuf = Buffer.from(expectedSig);
  const actualBuf = Buffer.from(sig);
  if (expectedBuf.length !== actualBuf.length) return false;

  let sigValid: boolean;
  try {
    sigValid = timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
  if (!sigValid) return false;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (!payload || typeof payload !== "object" || typeof (payload as { exp?: unknown }).exp !== "number") {
    return false;
  }

  const now = opts.now ?? Date.now();
  return (payload as { exp: number }).exp > now;
}

export interface BuildSlackOauthAccessBodyInput {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}

/** Build the form-encoded body for `POST oauth.v2.access` — pure so the
 * route's fetch call is a one-line pass-through and the request shape is
 * unit-testable without ever making the request. */
export function buildSlackOauthAccessBody(input: BuildSlackOauthAccessBodyInput): URLSearchParams {
  const body = new URLSearchParams();
  body.set("client_id", input.clientId);
  body.set("client_secret", input.clientSecret);
  body.set("code", input.code);
  body.set("redirect_uri", input.redirectUri);
  return body;
}

/** The normalized shape a successful `oauth.v2.access` response reduces to
 * — everything `upsertSlackInstallation` needs, nothing else. */
export interface SlackInstallationCandidate {
  teamId: string;
  teamName: string | null;
  botToken: string;
  botUserId: string;
  installedBySlackUserId: string | null;
  scopes: string | null;
  enterpriseId: string | null;
}

export type SlackOauthNormalizeResult =
  | { ok: true; installation: SlackInstallationCandidate }
  | {
      ok: false;
      reason: "not_ok" | "enterprise_install" | "missing_fields";
      slackError?: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Validate + normalize a raw `oauth.v2.access` JSON body. Every failure
 * mode the brief calls out lands here, and every branch that fails returns
 * an object with NO `installation` field at all — the type itself is the
 * "never a partial write" guarantee, not a convention the caller has to
 * remember:
 *
 * - `ok !== true` -> `{ ok: false, reason: "not_ok" }` (plus Slack's own
 *   short error enum, e.g. `"invalid_code"`, `"bad_client_secret"` — never
 *   the raw body, and Slack does not echo the code/secret/token back on
 *   failure anyway).
 * - `is_enterprise_install === true` -> `{ ok: false, reason:
 *   "enterprise_install" }`, checked BEFORE field extraction (spec §5): an
 *   org-wide Grid install is refused outright, never partially accepted
 *   because it happened to also carry a token.
 * - a 2xx body missing `access_token`, `bot_user_id`, or `team.id` ->
 *   `{ ok: false, reason: "missing_fields" }`.
 *
 * `enterprise_id` is recorded (not rejected on) for a NON-org-wide install
 * that merely happens to sit inside an Enterprise Grid org (spec §1's
 * `enterprise_id` column: "recorded, not supported").
 */
export function normalizeSlackOauthResponse(body: unknown): SlackOauthNormalizeResult {
  if (!isRecord(body)) {
    return { ok: false, reason: "missing_fields" };
  }

  if (body["ok"] !== true) {
    const slackError = typeof body["error"] === "string" ? body["error"] : undefined;
    return slackError ? { ok: false, reason: "not_ok", slackError } : { ok: false, reason: "not_ok" };
  }

  if (body["is_enterprise_install"] === true) {
    return { ok: false, reason: "enterprise_install" };
  }

  const team = isRecord(body["team"]) ? body["team"] : {};
  const authedUser = isRecord(body["authed_user"]) ? body["authed_user"] : {};
  const enterprise = isRecord(body["enterprise"]) ? body["enterprise"] : {};

  const accessToken = typeof body["access_token"] === "string" ? body["access_token"] : undefined;
  const botUserId = typeof body["bot_user_id"] === "string" ? body["bot_user_id"] : undefined;
  const teamId = typeof team["id"] === "string" ? team["id"] : undefined;

  if (!accessToken || !botUserId || !teamId) {
    return { ok: false, reason: "missing_fields" };
  }

  return {
    ok: true,
    installation: {
      teamId,
      teamName: typeof team["name"] === "string" ? team["name"] : null,
      botToken: accessToken,
      botUserId,
      installedBySlackUserId: typeof authedUser["id"] === "string" ? authedUser["id"] : null,
      scopes: typeof body["scope"] === "string" ? body["scope"] : null,
      enterpriseId: typeof enterprise["id"] === "string" ? enterprise["id"] : null,
    },
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlPage(title: string, bodyHtml: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
    `<body style="font-family:system-ui,sans-serif;display:flex;flex-direction:column;` +
    `align-items:center;justify-content:center;min-height:100vh;text-align:center;` +
    `padding:2rem;gap:0.75rem;">${bodyHtml}</body></html>`
  );
}

/** The success page: told to `/invite @Jace` into a channel and mention it
 * — installing alone does nothing until the bot is actually invited
 * somewhere. `teamName` is Slack-controlled input riding in an HTTP
 * response, so it is HTML-escaped like any other untrusted string. */
export function renderSlackConnectedPage(teamName: string | null): string {
  const heading = teamName ? `Jace is connected to ${escapeHtml(teamName)}` : "Jace is connected";
  return htmlPage(
    "Jace is connected",
    `<h1>${heading}</h1>` +
      `<p>Open a channel in Slack, run <code>/invite @Jace</code>, then mention @Jace to start a conversation.</p>`
  );
}

/** A generic declined/failed/refused page — same shape for every rejection
 * branch (declined, expired state, Enterprise Grid refusal, exchange
 * failure) so the callback route never has to hand-roll markup per case. */
export function renderSlackErrorPage(title: string, body: string): string {
  return htmlPage(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>`);
}

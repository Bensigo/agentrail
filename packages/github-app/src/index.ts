/**
 * @agentrail/github-app — pure GitHub App client (spec:
 * docs/superpowers/specs/2026-07-24-jace-github-app-identity-design.md §3/§6).
 *
 * Deliberately has ZERO workspace/DB knowledge: @agentrail/db-postgres
 * composes these into workspace-aware helpers (getInstallationToken), which
 * keeps the package dependency graph one-directional (db-postgres -> here,
 * never back). JWT is signed with node:crypto — no new dependency; GitHub
 * requires RS256, iat backdated for clock drift, exp <= 10 minutes.
 *
 * Tokens and private keys never appear in returned errors: every failure is
 * a closed-union reason code, same contract as apps/console/lib/github-merge.ts.
 */
import { createSign } from "node:crypto";

export interface GithubAppConfig {
  ok: true;
  appId: string;
  privateKey: string;
  slug: string;
  botUserId: string;
}
export interface GithubAppConfigMissing {
  ok: false;
  missing: string[];
}

const REQUIRED_VARS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_BOT_USER_ID",
] as const;

export function resolveGithubAppConfig(
  env: NodeJS.ProcessEnv
): GithubAppConfig | GithubAppConfigMissing {
  const missing = REQUIRED_VARS.filter((v) => !String(env[v] ?? "").trim());
  if (missing.length) return { ok: false, missing: [...missing] };
  // Env-var transport (Railway, compose env_file) often flattens PEM newlines
  // to literal "\n" — normalize so createSign always gets a real PEM.
  const privateKey = String(env["GITHUB_APP_PRIVATE_KEY"]).replace(/\\n/g, "\n");
  return {
    ok: true,
    appId: String(env["GITHUB_APP_ID"]).trim(),
    privateKey,
    slug: String(env["GITHUB_APP_SLUG"]).trim(),
    botUserId: String(env["GITHUB_APP_BOT_USER_ID"]).trim(),
  };
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

export function signAppJwt(
  appId: string,
  privateKeyPem: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // iat backdated 60s (GitHub's documented clock-drift allowance); exp 9min —
  // under the 10-minute hard cap with margin.
  const payload = b64url(
    JSON.stringify({ iss: appId, iat: nowSeconds - 60, exp: nowSeconds + 540 })
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKeyPem).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

export type GithubAppFailure = {
  ok: false;
  reason: "not_installed" | "github_unreachable" | "github_rejected";
};

const GITHUB_FETCH_TIMEOUT_MS = 8000;

async function appFetch(
  url: string,
  method: "GET" | "POST",
  cfg: { appId: string; privateKey: string },
  fetchImpl: typeof fetch
): Promise<{ ok: true; body: unknown } | GithubAppFailure> {
  let jwt: string;
  try {
    jwt = signAppJwt(cfg.appId, cfg.privateKey);
  } catch {
    // createSign(...).sign() throws synchronously on a malformed/truncated
    // PEM (a plausible env-var misconfiguration). Never lets this reach
    // fetchImpl, and keeps the closed-union contract: no bare rejection.
    return { ok: false, reason: "github_rejected" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
  let res: { ok: boolean; status: number; json: () => Promise<unknown> };
  try {
    res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "agentrail-console",
      },
      signal: controller.signal,
    } as RequestInit);
  } catch {
    return { ok: false, reason: "github_unreachable" };
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    // 404 = the installation id no longer exists — the app was uninstalled.
    // This is the spec's "lazy uninstall detection" surfacing point (§2).
    if (res.status === 404) return { ok: false, reason: "not_installed" };
    return { ok: false, reason: "github_rejected" };
  }
  const body = await res.json().catch(() => ({}));
  return { ok: true, body };
}

export async function mintInstallationToken(
  installationId: string,
  cfg: { appId: string; privateKey: string },
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: true; token: string; expiresAt: string } | GithubAppFailure> {
  const res = await appFetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    "POST",
    cfg,
    fetchImpl
  );
  if (!res.ok) return res;
  const body = res.body as { token?: unknown; expires_at?: unknown };
  if (typeof body.token !== "string" || !body.token) {
    return { ok: false, reason: "github_rejected" };
  }
  return {
    ok: true,
    token: body.token,
    expiresAt: typeof body.expires_at === "string" ? body.expires_at : "",
  };
}

export async function getInstallationAccount(
  installationId: string,
  cfg: { appId: string; privateKey: string },
  fetchImpl: typeof fetch = fetch
): Promise<
  { ok: true; login: string; type: "User" | "Organization" } | GithubAppFailure
> {
  const res = await appFetch(
    `https://api.github.com/app/installations/${installationId}`,
    "GET",
    cfg,
    fetchImpl
  );
  if (!res.ok) return res;
  const account = (res.body as { account?: { login?: unknown; type?: unknown } })
    .account;
  const login = typeof account?.login === "string" ? account.login : "";
  const type = account?.type === "Organization" ? "Organization" : "User";
  if (!login) return { ok: false, reason: "github_rejected" };
  return { ok: true, login, type };
}

/**
 * The git commit identity that attributes pushed commits to the App's bot
 * user. NOTE: the numeric id is the BOT USER's database id (GET /users/<slug>[bot]),
 * NOT the App id — the App id silently breaks avatar/profile linkage
 * (github-actions[bot] uses 41898282, not App id 15368).
 */
export function botCommitIdentity(
  slug: string,
  botUserId: string
): { name: string; email: string } {
  return {
    name: `${slug}[bot]`,
    email: `${botUserId}+${slug}[bot]@users.noreply.github.com`,
  };
}

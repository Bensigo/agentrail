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

/**
 * A deliberately narrow installation-token mint for correction delivery
 * preparation. Unlike {@link mintInstallationToken}, this asks GitHub for
 * exactly one repository and the two permissions a future issue-comment
 * carrier would need. It does not send a comment or otherwise contact a
 * repository.
 *
 * The result is intentionally a different closed union from the broad legacy
 * mint helper: callers must preserve the distinction between a known
 * unavailable carrier and an indeterminate GitHub result.
 */
export const MAX_CORRECTION_CARRIER_TOKEN_RESPONSE_BYTES = 64 * 1024;

export type CorrectionCarrierInstallationTokenResult =
  | {
      ok: true;
      token: string;
      expiresAt: string;
      permissionBasis: {
        repository: "scoped_installation_token";
        issues: "write";
        pullRequests: "write";
      };
    }
  | {
      ok: false;
      kind: "unavailable";
      reason:
        | "invalid_input"
        | "not_installed"
        | "credential_rejected"
        | "repository_not_granted"
        | "required_permissions_not_granted";
    }
  | {
      ok: false;
      kind: "indeterminate";
      reason: "github_unavailable" | "invalid_response";
    };

type CorrectionCarrierMintInput = {
  installationId: string;
  owner: string;
  repo: string;
};

const GITHUB_REPOSITORY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const GITHUB_INSTALLATION_ID = /^[0-9]{1,20}$/;
const MAX_CORRECTION_CARRIER_TOKEN_BYTES = 8192;
const MAX_CORRECTION_CARRIER_EXPIRY_BYTES = 64;

function isGithubRepositorySegment(value: string): boolean {
  return (
    GITHUB_REPOSITORY_SEGMENT.test(value) &&
    value !== "." &&
    value !== ".."
  );
}

function validCorrectionCarrierMintInput(
  input: unknown
): input is CorrectionCarrierMintInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const candidate = input as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 3 ||
    !("installationId" in candidate) ||
    !("owner" in candidate) ||
    !("repo" in candidate) ||
    typeof candidate.installationId !== "string" ||
    typeof candidate.owner !== "string" ||
    typeof candidate.repo !== "string"
  ) return false;
  return (
    GITHUB_INSTALLATION_ID.test(candidate.installationId) &&
    isGithubRepositorySegment(candidate.owner) &&
    isGithubRepositorySegment(candidate.repo)
  );
}

async function readBoundedGithubJson(
  response: Response,
  controller: AbortController
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^[0-9]+$/.test(declaredLength) ||
      Number(declaredLength) > MAX_CORRECTION_CARRIER_TOKEN_RESPONSE_BYTES)
  ) {
    void response.body?.cancel().catch(() => undefined);
    return { ok: false };
  }
  if (!response.body) return { ok: false };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let rejectAbort!: (reason?: unknown) => void;
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
    rejectAbort(new Error("github response timed out"));
  };
  const abort = new Promise<never>((_, reject) => {
    rejectAbort = reject;
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), abort]);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_CORRECTION_CARRIER_TOKEN_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        return { ok: false };
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      ok: true,
      body: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    };
  } catch {
    return { ok: false };
  } finally {
    controller.signal.removeEventListener("abort", onAbort);
  }
}

function hasCorrectionCarrierGrant(
  body: unknown,
  owner: string,
  repo: string
): body is {
  token: string;
  expires_at: string;
  repositories: Array<{ full_name: string }>;
  permissions: { issues: "write"; pull_requests: "write" };
} {
  if (!body || typeof body !== "object") return false;
  const typed = body as {
    token?: unknown;
    expires_at?: unknown;
    repositories?: unknown;
    permissions?: unknown;
  };
  if (
    typeof typed.token !== "string" ||
    typed.token.length === 0 ||
    typed.token.length > MAX_CORRECTION_CARRIER_TOKEN_BYTES ||
    !/^[A-Za-z0-9_.-]+$/.test(typed.token) ||
    typeof typed.expires_at !== "string" ||
    typed.expires_at.length === 0 ||
    typed.expires_at.length > MAX_CORRECTION_CARRIER_EXPIRY_BYTES ||
    !Number.isFinite(Date.parse(typed.expires_at)) ||
    Date.parse(typed.expires_at) <= Date.now() ||
    Date.parse(typed.expires_at) > Date.now() + 24 * 60 * 60 * 1000 ||
    !Array.isArray(typed.repositories) ||
    typed.repositories.length !== 1 ||
    !typed.repositories.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        typeof (entry as { full_name?: unknown }).full_name === "string"
    )
  ) {
    return false;
  }
  const fullName = (typed.repositories[0] as { full_name: string }).full_name;
  if (fullName.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) return false;
  const permissions = typed.permissions as
    | { issues?: unknown; pull_requests?: unknown }
    | undefined;
  return permissions?.issues === "write" && permissions.pull_requests === "write";
}

/**
 * Mints a repository-scoped GitHub App token suitable only for a later
 * correction-carrier attempt. The timeout remains active while the response
 * body streams, redirects are refused, and no failure carries a token or raw
 * GitHub body.
 */
export async function mintCorrectionCarrierInstallationToken(
  input: CorrectionCarrierMintInput,
  cfg: { appId: string; privateKey: string },
  fetchImpl: typeof fetch = fetch
): Promise<CorrectionCarrierInstallationTokenResult> {
  if (!validCorrectionCarrierMintInput(input)) {
    return { ok: false, kind: "unavailable", reason: "invalid_input" };
  }
  let jwt: string;
  try {
    jwt = signAppJwt(cfg.appId, cfg.privateKey);
  } catch {
    return { ok: false, kind: "unavailable", reason: "credential_rejected" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetchImpl(
        `https://api.github.com/app/installations/${input.installationId}/access_tokens`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "agentrail-console",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            repositories: [input.repo],
            permissions: { issues: "write", pull_requests: "write" },
          }),
          redirect: "error",
          signal: controller.signal,
        }
      );
    } catch {
      return { ok: false, kind: "indeterminate", reason: "github_unavailable" };
    }
    if (response.status !== 201) {
      void response.body?.cancel().catch(() => undefined);
      if (response.status === 404) {
        return { ok: false, kind: "unavailable", reason: "not_installed" };
      }
      if ([401, 403, 422].includes(response.status)) {
        return { ok: false, kind: "unavailable", reason: "credential_rejected" };
      }
      return { ok: false, kind: "indeterminate", reason: "github_unavailable" };
    }
    const parsed = await readBoundedGithubJson(response, controller);
    if (!parsed.ok) {
      return { ok: false, kind: "indeterminate", reason: "invalid_response" };
    }
    if (!hasCorrectionCarrierGrant(parsed.body, input.owner, input.repo)) {
      const typed = parsed.body as { repositories?: unknown; permissions?: unknown };
      if (!Array.isArray(typed?.repositories) || typed.repositories.length !== 1) {
        return { ok: false, kind: "indeterminate", reason: "invalid_response" };
      }
      const fullName = (typed.repositories[0] as { full_name?: unknown } | null)
        ?.full_name;
      if (typeof fullName !== "string") {
        return { ok: false, kind: "indeterminate", reason: "invalid_response" };
      }
      if (fullName.toLowerCase() !== `${input.owner}/${input.repo}`.toLowerCase()) {
        return { ok: false, kind: "unavailable", reason: "repository_not_granted" };
      }
      if (!typed?.permissions || typeof typed.permissions !== "object") {
        return { ok: false, kind: "indeterminate", reason: "invalid_response" };
      }
      const permissions = typed.permissions as {
        issues?: unknown;
        pull_requests?: unknown;
      };
      if (
        typeof permissions.issues !== "string" ||
        typeof permissions.pull_requests !== "string"
      ) {
        return { ok: false, kind: "indeterminate", reason: "invalid_response" };
      }
      if (permissions.issues !== "write" || permissions.pull_requests !== "write") {
        return {
          ok: false,
          kind: "unavailable",
          reason: "required_permissions_not_granted",
        };
      }
      return { ok: false, kind: "indeterminate", reason: "invalid_response" };
    }
    return {
      ok: true,
      token: parsed.body.token,
      expiresAt: parsed.body.expires_at,
      permissionBasis: {
        repository: "scoped_installation_token",
        issues: "write",
        pullRequests: "write",
      },
    };
  } finally {
    clearTimeout(timer);
  }
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

export type ListUserInstallationsFailure = {
  ok: false;
  // "unauthorized" is distinct from github_rejected: the install callback
  // needs to tell "the user's stored login token expired/was revoked"
  // (→ ask them to sign out/in) apart from any other GitHub-side rejection.
  reason: "unauthorized" | "github_unreachable" | "github_rejected";
};

export interface UserInstallationEntry {
  id: string;
  accountId: string;
  accountLogin: string;
  accountType: "User" | "Organization";
}

// Bound mirrors the backlog sweep's per-repo page cap (route.ts's
// MAX_PAGES_PER_REPO): a pathological account with thousands of
// installations must never hang the ownership check.
const MAX_INSTALLATION_PAGES = 10;
const INSTALLATIONS_PER_PAGE = 100;

/**
 * Lists the installations a GitHub App **user access token** can see, via
 * `GET /user/installations` (GitHub's documented endpoint for this token
 * type — distinct from the App-JWT-authenticated `appFetch` calls above,
 * which act on ANY installation of the App and carry no ownership
 * information).
 *
 * IMPORTANT — this endpoint is NOT an ownership check on its own: GitHub
 * returns an installation whenever the token's user shares ANY repo access
 * with it (user ∩ app repo sets), so an outside collaborator with read on
 * one repo of an org installation shows up here too. The install callback
 * uses this ONLY to narrow to "installations this user can see at all",
 * then layers `getUserOrgRole` (Organization) / account-id equality (User)
 * on top as the real ownership boundary — see install-callback/route.ts's
 * doc-comment.
 *
 * Response is a wrapper (`{ total_count, installations: [...] }`), not a
 * bare array; paginated `per_page=100` with the same short-page-stop idiom
 * as the backlog sweep (`sweepRepo` in
 * app/api/v1/runner/backlog/route.ts) — stop as soon as a page returns
 * fewer than `per_page` entries, bounded by MAX_INSTALLATION_PAGES. Each
 * entry's `account.id`/`account.login`/`account.type` are carried through
 * so the caller can resolve identity without a second round-trip.
 *
 * Never throws; never logs the token. 401 → `unauthorized`; network
 * failure → `github_unreachable`; any other non-2xx or malformed body →
 * `github_rejected`.
 */
export async function listUserInstallations(
  userToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<
  { ok: true; installations: UserInstallationEntry[] } | ListUserInstallationsFailure
> {
  const installations: UserInstallationEntry[] = [];
  let page = 1;
  while (page <= MAX_INSTALLATION_PAGES) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
    let res: { ok: boolean; status: number; json: () => Promise<unknown> };
    try {
      res = await fetchImpl(
        `https://api.github.com/user/installations?per_page=${INSTALLATIONS_PER_PAGE}&page=${page}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${userToken}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "agentrail-console",
          },
          signal: controller.signal,
        } as RequestInit
      );
    } catch {
      return { ok: false, reason: "github_unreachable" };
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      if (res.status === 401) return { ok: false, reason: "unauthorized" };
      return { ok: false, reason: "github_rejected" };
    }
    const body = (await res.json().catch(() => null)) as
      | { installations?: unknown }
      | null;
    const page_installations = body?.installations;
    if (!Array.isArray(page_installations)) {
      return { ok: false, reason: "github_rejected" };
    }
    for (const entry of page_installations) {
      const id = (entry as { id?: unknown } | null)?.id;
      if (id === undefined || id === null) continue;
      const account = (entry as { account?: { id?: unknown; login?: unknown; type?: unknown } } | null)
        ?.account;
      const accountId = account?.id;
      installations.push({
        id: String(id),
        accountId: accountId !== undefined && accountId !== null ? String(accountId) : "",
        accountLogin: typeof account?.login === "string" ? account.login : "",
        accountType: account?.type === "Organization" ? "Organization" : "User",
      });
    }
    if (page_installations.length < INSTALLATIONS_PER_PAGE) break;
    page += 1;
  }
  return { ok: true, installations };
}

export type GetUserOrgRoleFailure = {
  ok: false;
  // "not_a_member" (404) is distinct from "unauthorized" (401): the former
  // means the org itself rejects this user outright (→ forbidden), the
  // latter means the caller's stored login token is stale (→ verify_failed,
  // ask them to sign out/in).
  reason: "not_a_member" | "unauthorized" | "github_unreachable" | "github_rejected";
};

/**
 * The CALLING user's own role in `org`, via
 * `GET /user/memberships/orgs/{org}` (requires the App's Organization
 * Members read-only permission, granted to the user access token at
 * login). This is the real ownership boundary for an ORGANIZATION
 * installation: GitHub only lets account ADMINS install/manage Apps, so
 * "is this user an admin of the org" is the install callback's anti-IDOR
 * check for org accounts — `listUserInstallations` alone over-admits any
 * collaborator who merely shares one repo with the installation.
 *
 * 404 → `not_a_member` (the org doesn't recognize this user as a member at
 * all). `role` is `"admin"` or `"member"`; anything else GitHub returns
 * (e.g. `"billing_manager"`) is treated as `"member"` — never silently
 * promoted to admin. 401 → `unauthorized`. Network failure →
 * `github_unreachable`. Any other non-2xx → `github_rejected`. Never
 * throws; never logs the token.
 */
export async function getUserOrgRole(
  userToken: string,
  org: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: true; role: "admin" | "member" } | GetUserOrgRoleFailure> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
  let res: { ok: boolean; status: number; json: () => Promise<unknown> };
  try {
    res = await fetchImpl(
      `https://api.github.com/user/memberships/orgs/${encodeURIComponent(org)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${userToken}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "agentrail-console",
        },
        signal: controller.signal,
      } as RequestInit
    );
  } catch {
    return { ok: false, reason: "github_unreachable" };
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    if (res.status === 404) return { ok: false, reason: "not_a_member" };
    if (res.status === 401) return { ok: false, reason: "unauthorized" };
    return { ok: false, reason: "github_rejected" };
  }
  const body = (await res.json().catch(() => null)) as { role?: unknown } | null;
  return { ok: true, role: body?.role === "admin" ? "admin" : "member" };
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

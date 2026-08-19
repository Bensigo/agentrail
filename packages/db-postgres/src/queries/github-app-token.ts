/**
 * GitHub App installation credentials (spec:
 * docs/superpowers/specs/2026-07-24-jace-github-app-identity-design.md §5/§6).
 *
 * getInstallationToken(workspaceId) is the drop-in replacement for the
 * deleted getGithubToken: same (workspaceId) => Promise<string | null>
 * contract, so all ten former call sites swap imports without reshaping
 * their null-handling. Null means "workspace has no usable GitHub
 * credential" for ANY reason — no installation bound, App env unconfigured,
 * GitHub unreachable, or the App was uninstalled (lazy detection, spec §2).
 * Callers keep their existing "Connect GitHub" error copy on null.
 *
 * Tokens are minted fresh per call (spec §2: no caching in v1) and NEVER
 * stored or logged.
 */
import { and, eq, gt } from "drizzle-orm";
import { randomBytes } from "crypto";
import {
  resolveGithubAppConfig,
  mintInstallationToken,
  mintCorrectionCarrierInstallationToken,
} from "@agentrail/github-app";
import { db } from "../db.js";
import { workspaces, accounts } from "../schema/index.js";
import { githubInstallationIdentitySha256 } from "./change_records.js";

const INSTALL_STATE_BYTES = 24;
const INSTALL_STATE_TTL_MS = 30 * 60 * 1000;

export async function getGithubInstallation(workspaceId: string): Promise<{
  installationId: string;
  accountLogin: string;
  accountType: "User" | "Organization";
} | null> {
  const rows = await db
    .select({
      installationId: workspaces.githubInstallationId,
      accountLogin: workspaces.githubInstallationAccountLogin,
      accountType: workspaces.githubInstallationAccountType,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const row = rows[0];
  if (!row?.installationId) return null;
  return {
    installationId: row.installationId,
    accountLogin: row.accountLogin ?? "",
    accountType: row.accountType === "Organization" ? "Organization" : "User",
  };
}

/**
 * The reverse of {@link getGithubInstallation}: given a GitHub App
 * installation id (as delivered on every GitHub webhook payload's
 * `installation.id`, a JSON NUMBER), find the workspace it is bound to
 * (Arc B §2/§3 — the review-job webhook's workspace resolution).
 *
 * `workspaces.github_installation_id` is a TEXT column (see that column's
 * own schema comment) — not because GitHub's id is textual, but so it
 * round-trips without a `numeric`/`bigint` column's precision risk through
 * the JS driver. `String(installationId)` is therefore the required
 * coercion at this query's boundary: comparing the raw JS number against a
 * text column would send a numeric-typed bind parameter that never matches
 * a text value. Null when no workspace has this installation bound (e.g.
 * the App is installed on a repo/org whose owner never connected it to a
 * workspace, or the installation was uninstalled).
 */
export async function getWorkspaceByGithubInstallationId(
  installationId: number
): Promise<{ workspaceId: string } | null> {
  const rows = await db
    .select({ workspaceId: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.githubInstallationId, String(installationId)))
    .limit(1);
  const row = rows[0];
  return row ? { workspaceId: row.workspaceId } : null;
}

export async function getInstallationToken(
  workspaceId: string
): Promise<string | null> {
  try {
    const installation = await getGithubInstallation(workspaceId);
    if (!installation) return null;
    const cfg = resolveGithubAppConfig(process.env);
    if (!cfg.ok) return null;
    const minted = await mintInstallationToken(installation.installationId, {
      appId: cfg.appId,
      privateKey: cfg.privateKey,
    });
    return minted.ok ? minted.token : null;
  } catch {
    return null;
  }
}

export type GithubCorrectionCarrierCredentialResult =
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
      reason: "installation_or_permission_denied";
    }
  | {
      ok: false;
      kind: "indeterminate";
      reason: "github_unavailable" | "invalid_github_response" | "storage_unavailable";
    };

export type GithubDependencyBuilderCredentialResult = GithubCorrectionCarrierCredentialResult;

const GITHUB_REPOSITORY = /^([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type GithubCorrectionCarrierCredentialInput = {
  workspaceId: string;
  repo: string;
};

type GithubDependencyBuilderCredentialInput = GithubCorrectionCarrierCredentialInput & {
  expectedInstallationIdentitySha256: string;
};

function isGithubCorrectionCarrierCredentialInput(
  value: unknown
): value is GithubCorrectionCarrierCredentialInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 2 ||
    !("workspaceId" in input) ||
    !("repo" in input) ||
    typeof input.workspaceId !== "string" ||
    typeof input.repo !== "string" ||
    !UUID.test(input.workspaceId)
  ) {
    return false;
  }
  return GITHUB_REPOSITORY.test(input.repo);
}

function isGithubDependencyBuilderCredentialInput(
  value: unknown
): value is GithubDependencyBuilderCredentialInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return Object.keys(input).length === 3
    && isGithubCorrectionCarrierCredentialInput({
      workspaceId: input.workspaceId,
      repo: input.repo,
    })
    && typeof input.expectedInstallationIdentitySha256 === "string"
    && /^[a-f0-9]{64}$/.test(input.expectedInstallationIdentitySha256);
}

async function mintGithubRepositoryCredential(input: {
  repo: string;
  installation: NonNullable<Awaited<ReturnType<typeof getGithubInstallation>>>;
}): Promise<GithubCorrectionCarrierCredentialResult> {
  const match = GITHUB_REPOSITORY.exec(input.repo)!;
  const [, owner, repoName] = match;
  if (!input.installation.accountLogin
    || input.installation.accountLogin.toLowerCase() !== owner!.toLowerCase()) {
    return {
      ok: false,
      kind: "unavailable",
      reason: "installation_or_permission_denied",
    };
  }
  const cfg = resolveGithubAppConfig(process.env);
  if (!cfg.ok) {
    return {
      ok: false,
      kind: "unavailable",
      reason: "installation_or_permission_denied",
    };
  }
  let minted: Awaited<ReturnType<typeof mintCorrectionCarrierInstallationToken>>;
  try {
    minted = await mintCorrectionCarrierInstallationToken(
      {
        installationId: input.installation.installationId,
        owner: owner!,
        repo: repoName!,
      },
      { appId: cfg.appId, privateKey: cfg.privateKey }
    );
  } catch {
    return { ok: false, kind: "indeterminate", reason: "github_unavailable" };
  }
  if (minted.ok) {
    return {
      ok: true,
      token: minted.token,
      expiresAt: minted.expiresAt,
      permissionBasis: minted.permissionBasis,
    };
  }
  if (minted.kind === "indeterminate") {
    return {
      ok: false,
      kind: "indeterminate",
      reason: minted.reason === "github_unavailable"
        ? "github_unavailable"
        : "invalid_github_response",
    };
  }
  return {
    ok: false,
    kind: "unavailable",
    reason: "installation_or_permission_denied",
  };
}

/**
 * Resolves a repository-scoped correction-carrier credential without trusting
 * a caller-supplied installation or account. This is credential preparation,
 * not issue-comment delivery: it neither persists nor logs the minted token.
 */
export async function getGithubCorrectionCarrierCredential(
  input: GithubCorrectionCarrierCredentialInput
): Promise<GithubCorrectionCarrierCredentialResult> {
  if (!isGithubCorrectionCarrierCredentialInput(input)) {
    return {
      ok: false,
      kind: "unavailable",
      reason: "installation_or_permission_denied",
    };
  }
  let installation: Awaited<ReturnType<typeof getGithubInstallation>>;
  try {
    installation = await getGithubInstallation(input.workspaceId);
  } catch {
    return { ok: false, kind: "indeterminate", reason: "storage_unavailable" };
  }
  if (!installation) {
    return {
      ok: false,
      kind: "unavailable",
      reason: "installation_or_permission_denied",
    };
  }
  return mintGithubRepositoryCredential({ repo: input.repo, installation });
}

/**
 * Named least-authority credential boundary for the initial dependency Pack
 * handoff. This is not a new independent credential scope: it reuses the
 * existing exact-repository installation-token mint with only issues and Pull
 * Requests write. The delivery capability and lifecycle remain distinct from
 * correction custody.
 */
export async function getGithubDependencyBuilderCredential(
  input: GithubDependencyBuilderCredentialInput,
): Promise<GithubDependencyBuilderCredentialResult> {
  if (!isGithubDependencyBuilderCredentialInput(input)) {
    return { ok: false, kind: "unavailable", reason: "installation_or_permission_denied" };
  }
  let installation: Awaited<ReturnType<typeof getGithubInstallation>>;
  try {
    installation = await getGithubInstallation(input.workspaceId);
  } catch {
    return { ok: false, kind: "indeterminate", reason: "storage_unavailable" };
  }
  if (!installation || githubInstallationIdentitySha256({
    workspaceId: input.workspaceId,
    installationId: installation.installationId,
    accountLogin: installation.accountLogin,
    accountType: installation.accountType,
  }) !== input.expectedInstallationIdentitySha256) {
    return { ok: false, kind: "unavailable", reason: "installation_or_permission_denied" };
  }
  return mintGithubRepositoryCredential({ repo: input.repo, installation });
}

export async function bindWorkspaceGithubInstallation(
  workspaceId: string,
  data: { installationId: string; accountLogin: string; accountType: string }
): Promise<void> {
  await db
    .update(workspaces)
    .set({
      githubInstallationId: data.installationId,
      githubInstallationAccountLogin: data.accountLogin,
      githubInstallationAccountType: data.accountType,
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, workspaceId));
}

export async function mintGithubInstallState(
  workspaceId: string
): Promise<string> {
  const state = randomBytes(INSTALL_STATE_BYTES).toString("hex");
  const expiresAt = new Date(Date.now() + INSTALL_STATE_TTL_MS);
  await db
    .update(workspaces)
    .set({ githubInstallState: state, githubInstallStateExpiresAt: expiresAt })
    .where(eq(workspaces.id, workspaceId));
  return state;
}

/** Atomic single-use consume — mirrors consumeChatIdentityLinkToken exactly. */
export async function consumeGithubInstallState(
  state: string
): Promise<{ workspaceId: string } | null> {
  const now = new Date();
  const rows = await db
    .update(workspaces)
    .set({ githubInstallState: null, githubInstallStateExpiresAt: null })
    .where(
      and(
        eq(workspaces.githubInstallState, state),
        gt(workspaces.githubInstallStateExpiresAt, now)
      )
    )
    .returning({ id: workspaces.id });
  const row = rows[0];
  return row ? { workspaceId: row.id } : null;
}

/**
 * The signed-in user's stored GitHub App **user access token** AND their
 * `provider_account_id` (`accounts.access_token` /
 * `accounts.provider_account_id` where `provider = 'github'` and
 * `user_id = userId`) — minted at LOGIN time by the App's OAuth flow (see
 * cd2c0c92 "console login via the Jace GitHub App's OAuth").
 *
 * Used ONLY by the install callback's ownership gate:
 *   - `accessToken` calls `GET /user/installations` /
 *     `GET /user/memberships/orgs/{org}` to narrow down and verify a
 *     caller-supplied `installation_id`.
 *   - `providerAccountId` is the caller's OWN numeric GitHub user id, used
 *     for rename-proof equality against a PERSONAL installation's
 *     `account.id` (a GitHub login can be renamed; the numeric id cannot) —
 *     see install-callback/route.ts's doc-comment.
 * Neither is a repo credential: per spec §4, all repo access rides
 * installation tokens (`getInstallationToken`) exclusively. Returns null
 * when the user never linked GitHub, or either field is missing (fail
 * closed — a partial identity is not enough to verify ownership). Never
 * logged or returned to the client.
 *
 * Deliberately a distinct, separately-named function from
 * `getUserGithubAccessToken` in `queries/index.ts` (a different, #1294-era
 * workspace-owner-based helper being retired later in this stack) — do not
 * merge the two.
 */
export async function getUserGithubIdentityById(
  userId: string
): Promise<{ accessToken: string; providerAccountId: string } | null> {
  const rows = await db
    .select({
      accessToken: accounts.access_token,
      providerAccountId: accounts.providerAccountId,
    })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, "github")))
    .limit(1);
  const row = rows[0];
  if (!row?.accessToken || !row?.providerAccountId) return null;
  return {
    accessToken: row.accessToken,
    providerAccountId: row.providerAccountId,
  };
}

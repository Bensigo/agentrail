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
} from "@agentrail/github-app";
import { db } from "../db.js";
import { workspaces, accounts } from "../schema/index.js";

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
 * The signed-in user's stored GitHub App **user access token**
 * (`accounts.access_token` where `provider = 'github'` and
 * `user_id = userId`) — the token minted at LOGIN time by the App's OAuth
 * flow (see cd2c0c92 "console login via the Jace GitHub App's OAuth").
 *
 * Used ONLY by the install callback's ownership gate, to call
 * `GET /user/installations` and confirm a caller-supplied `installation_id`
 * actually belongs to this user before binding it to a workspace (the
 * anti-IDOR check — see install-callback/route.ts). It is NOT a repo
 * credential: per spec §4, all repo access rides installation tokens
 * (`getInstallationToken`) exclusively, never this one. Returns null when
 * the user never linked GitHub or no token is stored. Never logged or
 * returned to the client.
 *
 * Deliberately a distinct, separately-named function from
 * `getUserGithubAccessToken` in `queries/index.ts` (a different, #1294-era
 * workspace-owner-based helper being retired later in this stack) — do not
 * merge the two.
 */
export async function getUserGithubAccessTokenById(
  userId: string
): Promise<string | null> {
  const rows = await db
    .select({ accessToken: accounts.access_token })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, "github")))
    .limit(1);
  return rows[0]?.accessToken ?? null;
}

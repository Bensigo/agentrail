import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db.js";
import { encryptSecret, decryptSecret } from "../crypto.js";
import { slackInstallations } from "../schema/slack_installations.js";

/**
 * Slack installation queries (spec §1,
 * docs/superpowers/specs/2026-07-29-slack-multi-workspace-design.md). One row
 * per Slack team, keyed by `team_id` — see `schema/slack_installations.ts`
 * for the full WHY (modelled on `chat_identities`, not `connectors`).
 *
 * `bot_token` is encrypted at rest with the existing `encryptSecret` /
 * `decryptSecret` (AES-256-GCM, `enc:v1:` format, `crypto.ts`) — NO new
 * crypto is introduced here. `upsertSlackInstallation` encrypts on write;
 * `getSlackInstallation` decrypts on read and is the ONLY place the
 * plaintext token is reconstituted.
 */

export interface UpsertSlackInstallationInput {
  teamId: string;
  teamName?: string | null;
  botToken: string;
  botUserId: string;
  installedBySlackUserId?: string | null;
  scopes?: string | null;
  enterpriseId?: string | null;
  /**
   * The AgentRail workspace that STARTED this install, when the install began
   * from a signed-in console session (the install route membership-checks the
   * caller before signing it into the OAuth `state`, so this is always
   * server-derived — never a client-supplied string). Omitted for an install
   * that arrived with no workspace context, e.g. Slack's App Directory.
   */
  workspaceId?: string | null;
}

/**
 * Upsert-by-`team_id` — the OAuth callback's write path (both a first
 * install and a reinstall land here). The bot token is encrypted BEFORE it
 * ever touches the `values()` call, so the plaintext never appears in a
 * query log. `revoked_at` is unconditionally cleared to `null` on both the
 * insert path and the conflict-update path: a reinstall after an
 * `app_uninstalled` must reactivate the row, not leave it looking revoked.
 *
 * `workspace_id` is the ONE column the conflict path does not overwrite
 * blind: it is `coalesce(excluded.workspace_id, slack_installations.
 * workspace_id)`, so a workspace-attributed install can be re-run later with
 * no workspace context (an App Directory reinstall, say) without silently
 * wiping the attribution the console's Gateways page reads to decide Slack is
 * connected. A reinstall that DOES carry a workspace still re-points it —
 * last attributed install wins, which is the only sensible answer when a
 * Slack team is claimed by a different workspace.
 */
export async function upsertSlackInstallation(
  input: UpsertSlackInstallationInput
): Promise<void> {
  const now = new Date();
  const encryptedToken = encryptSecret(input.botToken);

  const row = {
    teamId: input.teamId,
    teamName: input.teamName ?? null,
    botToken: encryptedToken,
    botUserId: input.botUserId,
    installedBySlackUserId: input.installedBySlackUserId ?? null,
    scopes: input.scopes ?? null,
    enterpriseId: input.enterpriseId ?? null,
    workspaceId: input.workspaceId ?? null,
    revokedAt: null,
    updatedAt: now,
  };

  await db
    .insert(slackInstallations)
    .values(row)
    .onConflictDoUpdate({
      target: slackInstallations.teamId,
      set: {
        ...row,
        workspaceId: sql`coalesce(excluded.${sql.raw(
          slackInstallations.workspaceId.name
        )}, ${slackInstallations.workspaceId})`,
      },
    });
}

/** One live Slack installation as the console's Gateways surface reads it —
 * deliberately no `botToken` field at all, so this projection cannot leak a
 * credential into a page or an API response by omission. */
export interface WorkspaceSlackInstallation {
  teamId: string;
  teamName: string | null;
}

/**
 * Every LIVE Slack installation attributed to a workspace, oldest first.
 *
 * This is the read that fixes "the Gateways page shows Add to Slack even
 * though Slack is connected": Slack's connect act is the OAuth install, which
 * writes a row HERE and no chat identity, so a page that only consulted
 * `chat_identities` could never see it. Revoked rows (Slack's
 * `app_uninstalled`) are excluded, which also makes the reverse true — remove
 * the app from Slack and the console goes back to offering the install.
 */
export async function listSlackInstallationsForWorkspace(
  workspaceId: string
): Promise<WorkspaceSlackInstallation[]> {
  return db
    .select({
      teamId: slackInstallations.teamId,
      teamName: slackInstallations.teamName,
    })
    .from(slackInstallations)
    .where(
      and(
        eq(slackInstallations.workspaceId, workspaceId),
        isNull(slackInstallations.revokedAt)
      )
    )
    .orderBy(slackInstallations.createdAt);
}

/** The non-secret-shaped view `getSlackInstallation` returns — `botToken` is
 * the DECRYPTED plaintext, the only place this layer reconstitutes it. */
export interface SlackInstallation {
  teamId: string;
  teamName: string | null;
  botToken: string;
  botUserId: string;
  enterpriseId: string | null;
}

/**
 * Look up a Slack installation by `team_id`, decrypting the stored bot
 * token. Returns `null` for BOTH an absent row and a revoked one
 * (`revoked_at` set) — collapsing the two cases here means every caller
 * (mention detection, outbound posting) fails closed on a single `null`
 * check instead of having to remember to re-check `revoked_at` itself.
 */
export async function getSlackInstallation(
  teamId: string
): Promise<SlackInstallation | null> {
  const [row] = await db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.teamId, teamId))
    .limit(1);

  if (!row || row.revokedAt) return null;

  return {
    teamId: row.teamId,
    teamName: row.teamName,
    botToken: decryptSecret(row.botToken),
    botUserId: row.botUserId,
    enterpriseId: row.enterpriseId,
  };
}

/**
 * Mark a Slack installation revoked (Slack's `app_uninstalled` event).
 * NEVER deletes the row — `revoked_at` is the audit trail, and
 * `upsertSlackInstallation` clears it back to `null` on a later reinstall.
 */
export async function revokeSlackInstallation(teamId: string): Promise<void> {
  await db
    .update(slackInstallations)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(slackInstallations.teamId, teamId));
}

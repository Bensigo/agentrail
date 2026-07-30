import { eq } from "drizzle-orm";
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
}

/**
 * Upsert-by-`team_id` — the OAuth callback's write path (both a first
 * install and a reinstall land here). The bot token is encrypted BEFORE it
 * ever touches the `values()` call, so the plaintext never appears in a
 * query log. `revoked_at` is unconditionally cleared to `null` on both the
 * insert path and the conflict-update path: a reinstall after an
 * `app_uninstalled` must reactivate the row, not leave it looking revoked.
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
    revokedAt: null,
    updatedAt: now,
  };

  await db
    .insert(slackInstallations)
    .values(row)
    .onConflictDoUpdate({
      target: slackInstallations.teamId,
      set: row,
    });
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

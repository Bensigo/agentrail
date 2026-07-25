import {
  getConnector,
  hasAnyJaceReply,
  listChatIdentitiesForWorkspace,
  listInvites,
  listWorkspaceMembers,
} from "@agentrail/db-postgres";
import {
  deriveOnboardingSteps,
  type OnboardingStep,
  type OnboardingStepsInput,
} from "./onboarding-steps";
import { isConsoleChatEnabled } from "./chat/feature-flags";

/**
 * Server-only I/O for the `/setup` onboarding wizard (three-step rebuild).
 * Gathers the raw signals `deriveOnboardingSteps` (pure, `onboarding-steps.ts`)
 * needs, plus a little extra display data the wizard UI wants (the repo
 * list, the stored webhook secret, the linked channel identities' display
 * names). Mirrors the digest split (`digest/digest-helpers.ts` is pure;
 * `digest/route.ts` does the I/O) — this file does the I/O, the derivation
 * stays pure and unit-tested on its own.
 *
 * Called from two places: the `GET /onboarding` route (the wizard polls it)
 * and the Home progress banner (a server component — no HTTP round trip).
 *
 * Skip-flag homes (all three steps are individually skippable, no new
 * table — see the doc-comments on `ConnectorConfig` in
 * `packages/db-postgres/src/schema/connectors.ts` for the full rationale):
 *   - `connect-github` → the `github` connector row's jsonb config
 *     (`githubSkippedAt`).
 *   - `invite-team`    → piggybacks on the SAME `github` row
 *     (`inviteTeamSkippedAt`) — invite-team has no connector of its own.
 *   - `message-jace`   → the `telegram` connector row's jsonb config
 *     (`channelSkippedAt` — unchanged field name from the step this
 *     replaced, so an existing skip survives the rename).
 */

export interface OnboardingData {
  steps: OnboardingStep[];
  github: {
    repoCount: number;
    repos: string[];
    hasWebhookSecret: boolean;
    webhookSecret: string | null;
    skipped: boolean;
  };
  /**
   * Everything the `message-jace` step needs — collapses the old, separate
   * `channel` + `chat` fields (from the two steps this one step replaced)
   * into a single honest shape.
   */
  messageJace: {
    /** `connected` (channel) OR `jaceReplied` (chat) — either proves the
     * user reached Jace. Drives the step's completion. */
    connected: boolean;
    skipped: boolean;
    /**
     * Display names of the workspace's linked telegram chat identities —
     * `[]` when none are linked yet. Names only: `platformUserId` is not for
     * the client (see `listChatIdentitiesForWorkspace`).
     */
    linkedNames: (string | null)[];
    /** A real jace_messages reply already exists (`hasAnyJaceReply`) — lets
     * the UI say "Jace replied" when that's the reason this step is
     * complete and no Telegram identity is linked yet. */
    jaceReplied: boolean;
  };
  invites: {
    count: number;
    skipped: boolean;
  };
}

export async function loadOnboardingData(
  workspaceId: string
): Promise<OnboardingData> {
  const chatEnabled = isConsoleChatEnabled(workspaceId);

  const [
    githubConnector,
    telegramConnector,
    chatIdentities,
    pendingInvites,
    members,
    jaceReplied,
  ] = await Promise.all([
    getConnector(workspaceId, "github"),
    // Still read for `channelSkippedAt` — the skip mechanism is unchanged.
    getConnector(workspaceId, "telegram"),
    listChatIdentitiesForWorkspace(workspaceId),
    listInvites(workspaceId), // pending, unexpired only
    listWorkspaceMembers(workspaceId),
    // Only worth checking once the surface is actually reachable — a
    // workspace with the flag off can never have a jace_messages row anyway
    // (the send/reply endpoints 404 while it's off), so skip the query.
    chatEnabled ? hasAnyJaceReply(workspaceId) : Promise.resolve(false),
  ]);

  const repos = githubConnector?.config.repos ?? [];
  const webhookSecret = githubConnector?.config.webhookSecret ?? null;
  const githubSkipped = Boolean(githubConnector?.config.githubSkippedAt);
  const inviteTeamSkipped = Boolean(
    githubConnector?.config.inviteTeamSkippedAt
  );

  // Spine-backed signal (connectors-channels cutover): connected once the
  // workspace has ≥1 linked chat identity for telegram — a user DM'd the
  // shared bot and that conversation was recorded — never a stored
  // credential. `listChatIdentitiesForWorkspace` returns every platform for
  // the workspace, so filter down to telegram's own (the only channel kind
  // the wizard supports today).
  const telegramIdentities = chatIdentities.filter(
    (identity) => identity.platform === "telegram"
  );
  const channelConnected = telegramIdentities.length > 0;
  // Either signal proves the user reached Jace (owner spec, verbatim): a
  // linked Telegram identity, or a real console-chat reply.
  const messageJaceConnected = channelConnected || jaceReplied;
  const messageJaceSkipped = Boolean(telegramConnector?.config.channelSkippedAt);

  // "Reached a teammate" = a still-pending invite, or a membership beyond the
  // owner (an accepted invite becomes a membership row and drops out of
  // listInvites — counting members too means this step never regresses back
  // to incomplete once someone actually joins).
  const extraMembers = Math.max(members.length - 1, 0);
  const invitesCount = pendingInvites.length + extraMembers;

  const input: OnboardingStepsInput = {
    github: {
      repoCount: repos.length,
      hasWebhookSecret: Boolean(webhookSecret),
      skipped: githubSkipped,
    },
    invites: { count: invitesCount, skipped: inviteTeamSkipped },
    messageJace: { connected: messageJaceConnected, skipped: messageJaceSkipped },
  };

  return {
    steps: deriveOnboardingSteps(input),
    github: {
      repoCount: repos.length,
      repos,
      hasWebhookSecret: Boolean(webhookSecret),
      webhookSecret,
      skipped: githubSkipped,
    },
    messageJace: {
      connected: messageJaceConnected,
      skipped: messageJaceSkipped,
      // Display names only — never platformUserId (see the interface doc).
      linkedNames: telegramIdentities.map((identity) => identity.displayName),
      jaceReplied,
    },
    invites: { count: invitesCount, skipped: inviteTeamSkipped },
  };
}

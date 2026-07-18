import {
  getConnector,
  getWorkspace,
  hasActiveSelfHostedRunner,
  listInvites,
  listWorkspaceMembers,
} from "@agentrail/db-postgres";
import {
  deriveOnboardingSteps,
  type OnboardingStep,
  type OnboardingStepsInput,
} from "./onboarding-steps";

/**
 * Server-only I/O for the `/setup` onboarding wizard (#1233). Gathers the raw
 * signals `deriveOnboardingSteps` (pure, `onboarding-steps.ts`) needs, plus a
 * little extra display data the wizard UI wants (the repo list, the stored
 * webhook secret, the resolved channel chat id). Mirrors the digest split
 * (`digest/digest-helpers.ts` is pure; `digest/route.ts` does the I/O) — this
 * file does the I/O, the derivation stays pure and unit-tested on its own.
 *
 * Called from two places: the `GET /onboarding` route (the wizard polls it)
 * and the Home progress banner (a server component — no HTTP round trip,
 * spec §5 "Home progress banner … server-derives from the same pure
 * function's inputs").
 */

export interface OnboardingData {
  steps: OnboardingStep[];
  github: {
    repoCount: number;
    repos: string[];
    hasWebhookSecret: boolean;
    webhookSecret: string | null;
  };
  channel: {
    connected: boolean;
    skipped: boolean;
    chatId: string | null;
  };
  invites: {
    count: number;
  };
  runner: {
    /** True whenever the workspace has ANY execution path — hosted (the
     * default) or an active self-hosted runner. Drives the "Attach a runner"
     * step's completion (#1268, workspaceHasExecutionPath). */
    connected: boolean;
    /** Specifically whether a self-hosted runner (not hosted-fleet
     * execution) is live — lets the UI say something honest instead of
     * calling hosted-fleet execution "your runner" (#1268). */
    selfHosted: boolean;
  };
}

export async function loadOnboardingData(
  workspaceId: string
): Promise<OnboardingData> {
  const [githubConnector, telegramConnector, pendingInvites, members, workspace, selfHostedActive] =
    await Promise.all([
      getConnector(workspaceId, "github"),
      getConnector(workspaceId, "telegram"),
      listInvites(workspaceId), // pending, unexpired only
      listWorkspaceMembers(workspaceId),
      getWorkspace(workspaceId),
      hasActiveSelfHostedRunner(workspaceId),
    ]);

  // Same disjunct as `workspaceHasExecutionPath` (the named onboard-enqueue
  // gate the connect-time routes use — see its doc-comment in
  // packages/db-postgres/src/queries/index.ts), derived LOCALLY here instead
  // of calling it: this loader also needs the bare `selfHosted` signal for
  // honest wizard copy, and the predicate internally runs the same two reads
  // — calling both on the wizard's 4-second poll loop would query
  // hasActiveSelfHostedRunner twice per tick for no reason. Keep this line in
  // lockstep with workspaceHasExecutionPath if that predicate ever changes.
  const hasExecutionPath = Boolean(workspace?.hostedExecution) || selfHostedActive;

  const repos = githubConnector?.config.repos ?? [];
  const webhookSecret = githubConnector?.config.webhookSecret ?? null;
  const channelConnected = Boolean(telegramConnector?.hasSecret);
  const channelSkipped = Boolean(telegramConnector?.config.channelSkippedAt);
  // "Reached a teammate" = a still-pending invite, or a membership beyond the
  // owner (an accepted invite becomes a membership row and drops out of
  // listInvites — counting members too means this step never regresses back
  // to incomplete once someone actually joins).
  const extraMembers = Math.max(members.length - 1, 0);
  const invitesCount = pendingInvites.length + extraMembers;

  const input: OnboardingStepsInput = {
    github: { repoCount: repos.length, hasWebhookSecret: Boolean(webhookSecret) },
    channel: { connected: channelConnected, skipped: channelSkipped },
    invites: { count: invitesCount },
    runner: { connected: hasExecutionPath },
  };

  return {
    steps: deriveOnboardingSteps(input),
    github: {
      repoCount: repos.length,
      repos,
      hasWebhookSecret: Boolean(webhookSecret),
      webhookSecret,
    },
    channel: {
      connected: channelConnected,
      skipped: channelSkipped,
      chatId: telegramConnector?.config.chatId ?? null,
    },
    invites: { count: invitesCount },
    runner: { connected: hasExecutionPath, selfHosted: selfHostedActive },
  };
}

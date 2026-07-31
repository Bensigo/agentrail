import { NextRequest, NextResponse } from "next/server";
import {
  db,
  claimQueueEntry,
  touchApiKeyLastUsed,
  hasActiveSelfHostedRunner,
  getMcpConnectorKeys,
  getInstallationToken,
  getWorkspaceBudgetState,
  sumWorkspaceSpendSince,
  markBudgetExhaustedNotified,
  isBillingEnabled,
  peekNextClaimEstimateUsd,
  walletCanAdmit,
  // Monthly engineering-capacity gate (subscription platform spec §6 point
  // 2 / §7) — see the gate block's own comment below, ahead of the wallet
  // admission block, for the full orchestration.
  countAccountRunsStartedInWindow,
  recordUpgradePromptOnce,
  latestChatSessionForWorkspace,
} from "@agentrail/db-postgres";
import { resolveGithubAppConfig, botCommitIdentity } from "@agentrail/github-app";
import { recordRunLifecycleEvent } from "@agentrail/db-clickhouse";
import { requireBearer } from "../../../../../lib/bearer-auth";
import { resolvePolicyForWorkspace } from "../../../../../lib/policy/resolve-policy";
import { subscriptionsEnforced } from "../../../../../lib/policy/feature-flags";
import { notifyWorkspaceBudgetExhausted, notifyAccountCapacity } from "./notify";

/** Response header naming the reason an empty 204 was returned. Set ONLY
 * when the workspace's monthly budget ceiling is why — never on an ordinary
 * empty-queue 204 (see the two 204 returns below that do NOT set it). Old
 * runner clients ignore unknown headers; a future runner build can log it
 * (issue #1269 PR ②b). */
const CLAIM_BLOCKED_HEADER = "X-Agentrail-Claim-Blocked";

/**
 * The current UTC calendar month as both a stable "YYYY-MM" period key (the
 * markBudgetExhaustedNotified dedup key) and its [start, end) ISO bounds
 * (sumWorkspaceSpendSince's window). Bucketing is by `runs.created_at`,
 * stamped at CLAIM time, not completion — a coarse, honestly-documented
 * tradeoff (queries/workspace_budget.ts + issue #1269 PR② recon §1/§2): a run
 * claimed in the last minute of a month books to that month even if it
 * finishes into the next one, and an in-flight run's cost is invisible to
 * this SUM until it reports (self-hosted runners never heartbeat cost).
 */
function currentBudgetWindow(now: Date = new Date()): {
  period: string;
  periodStartIso: string;
  periodEndIso: string;
} {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const periodStartIso = new Date(Date.UTC(year, month, 1)).toISOString();
  const periodEndIso = new Date(Date.UTC(year, month + 1, 1)).toISOString();
  const period = `${year}-${String(month + 1).padStart(2, "0")}`;
  return { period, periodStartIso, periodEndIso };
}

/**
 * CAS-then-send for a capacity notice (subscription platform spec §6 point
 * 2 / §7): decides whether THIS call is the one that gets to notify
 * (`recordUpgradePromptOnce`'s insert-wins CAS — the same pattern
 * `markBudgetExhaustedNotified`'s UPDATE-CAS gives the workspace-budget
 * block above, insert-based rather than update-based since there is no
 * pre-existing row to flip), and only the winner calls into `notify.ts`'s
 * `notifyAccountCapacity` to actually deliver.
 *
 * `periodKey`: `"capacity"` cools down DAILY (UTC `YYYY-MM-DD`, computed
 * fresh here rather than derived from `period`) — a paused workspace
 * re-polls this route continuously, so without a daily reset the very
 * first blocked poll would burn the ONLY prompt for the rest of the month.
 * `"capacity_warning"` cools down MONTHLY (`period`, UTC `YYYY-MM`, passed
 * straight through) — exactly ONE soft notice per period
 * (`schema/upgrade_prompt_events.ts`'s own `periodKey` doc-comment).
 *
 * `conversationKey`: the delivered session's own `conversationKey` when
 * `latestChatSessionForWorkspace` finds one, else the sentinel
 * `workspace:${workspaceId}` — a dedup key is still required even when
 * there is nobody to actually tell (no chat session bound yet), so the CAS
 * has something stable to key on rather than skipping the row entirely.
 * `channel` is audit-trail only (that schema's own doc-comment: it sits
 * OUTSIDE the four-column dedup index), so `"none"` for the no-session case
 * is safe — it never affects who gets deduped against whom.
 *
 * `notifyAccountCapacity` re-resolves `latestChatSessionForWorkspace` on its
 * own for delivery (see that function's own doc-comment) — a second,
 * independent lookup rather than threading this one's result through, so it
 * stays a self-contained, independently callable/testable unit exactly like
 * `notifyWorkspaceBudgetExhausted` above.
 *
 * Called `void`-fire-and-forget from the gate block below — the claim
 * response must never wait on chat delivery — so this function IS the
 * error boundary: EVERYTHING here runs inside one try/catch. Nothing
 * upstream of a bare `void` call ever sees a rejection, so a failure here
 * that escaped this catch would surface only as an unhandled promise
 * rejection, not as anything the route's own try/catch (which wraps the
 * gate block, not this fire-and-forget tail) could ever observe.
 */
async function maybeNotifyCapacity(
  billingAccountId: string,
  workspaceId: string,
  kind: "capacity" | "capacity_warning",
  period: string
): Promise<void> {
  try {
    const session = await latestChatSessionForWorkspace(workspaceId);
    const conversationKey = session?.conversationKey ?? `workspace:${workspaceId}`;
    const periodKey =
      kind === "capacity" ? new Date().toISOString().slice(0, 10) : period;

    const won = await recordUpgradePromptOnce(db, {
      billingAccountId,
      kind,
      conversationKey,
      channel: session?.channel ?? "none",
      periodKey,
    });
    if (!won) return;

    await notifyAccountCapacity(workspaceId, kind);
  } catch (err) {
    console.error(
      `[capacity-notify] failed to notify workspace ${workspaceId} (${kind}):`,
      err
    );
  }
}

/**
 * Runner work-claim. Bearer-authenticated with the runner token (an api_key).
 * Atomically claims the oldest `queued` queue entry for the workspace and flips
 * it to `running`, returning it as a WorkItem. 204 (empty) when nothing queued.
 *
 * Self-hosted precedence (#1267 PR ①, Locked-5): a `kind: 'fleet'` bearer (the
 * hosted fleet, minted by POST /api/v1/fleet/workspace-tokens/sync) backs off
 * with a plain 204 whenever the workspace has an active self-hosted runner —
 * a live self-hosted runner always wins its own workspace's queue; the fleet
 * only serves workspaces with none (or a gone-stale one). "Active" is the
 * same `hasActiveRunner` heuristic used elsewhere, narrowed to
 * kind='self_hosted' (see hasActiveSelfHostedRunner's own doc-comment): a
 * non-revoked key whose `last_used_at` is within the last hour. A self-hosted
 * runner that died without revoking its key still shadows the workspace from
 * the fleet for up to that window — accepted v1 behavior; an operator who
 * wants the fleet to pick up slack immediately would need to revoke the dead
 * key rather than wait it out. `kind: 'self_hosted'` bearers (and any future
 * non-'fleet' kind) are byte-identical to pre-#1267 behavior: this guard runs
 * ONLY when `auth.kind === 'fleet'`.
 */
export async function GET(request: NextRequest) {
  const auth = await requireBearer(request);
  if (auth instanceof NextResponse) {
    return auth;
  }

  const workspaceId = new URL(request.url).searchParams.get("workspace_id");
  if (!workspaceId) {
    return NextResponse.json(
      { error: "workspace_id is required" },
      { status: 400 }
    );
  }

  if (auth.workspaceId !== workspaceId) {
    return NextResponse.json(
      { error: "API key does not belong to the specified workspace" },
      { status: 403 }
    );
  }

  await touchApiKeyLastUsed(auth.apiKeyId);

  if (auth.kind === "fleet" && (await hasActiveSelfHostedRunner(workspaceId))) {
    return new NextResponse(null, { status: 204 });
  }

  // Workspace monthly-budget ceiling (#1269 PR ②a): a coarse, workspace-level
  // spend guardrail on top of the per-issue leash. Applies to BOTH bearer
  // kinds — it's a workspace property, not a runner-fleet property (unlike
  // the fleet-precedence guard above). A NULL ceiling (the default) skips
  // this ENTIRELY: no SUM over `runs` runs, so an uncapped workspace's claim
  // poll costs exactly what it did before this block existed.
  const budgetState = await getWorkspaceBudgetState(workspaceId);
  if (budgetState && budgetState.monthlyBudgetUsd !== null) {
    const { period, periodStartIso, periodEndIso } = currentBudgetWindow();
    const spend = await sumWorkspaceSpendSince(
      workspaceId,
      periodStartIso,
      periodEndIso
    );
    if (spend >= budgetState.monthlyBudgetUsd) {
      // Atomic compare-and-set: send the chat notice ONLY on the flip into
      // this period — race-safe for two concurrent blocked claims (see
      // markBudgetExhaustedNotified's own doc-comment). Best-effort: a send
      // failure must never fail the claim response.
      if (await markBudgetExhaustedNotified(workspaceId, period)) {
        try {
          await notifyWorkspaceBudgetExhausted(
            workspaceId,
            spend,
            budgetState.monthlyBudgetUsd
          );
        } catch (err) {
          console.error(
            "[runner/claim] failed to send budget-exhausted notice:",
            err
          );
        }
      }
      return new NextResponse(null, {
        status: 204,
        headers: { [CLAIM_BLOCKED_HEADER]: "workspace-budget" },
      });
    }
  }

  // Monthly engineering-capacity gate (subscription platform spec §6 point 2
  // / §7): ACCOUNT-wide admitted-run count (every workspace on the billing
  // account — countAccountRunsStartedInWindow joins out through
  // workspaces.billing_account_id, unlike the WORKSPACE-scoped budget block
  // above) against policy.monthlyCapacity, over the same UTC-calendar-month
  // window currentBudgetWindow() already gives the budget block above. At
  // 100% new tasks pause: this 204 + header, BEFORE claimQueueEntry —
  // queue_entries stays untouched, so the entry stays queued and the gate
  // self-heals at month rollover, exactly like the workspace-budget block.
  // Running work is unaffected (this gate sits before claimQueueEntry only).
  // At >=80% (and still under 100%) one soft notice fires, but the claim
  // still proceeds.
  //
  // subscriptionsEnforced() gates the WHOLE block first (spec §6: one
  // kill-switch, four gates) — flag off costs nothing beyond that one
  // boolean read, byte-identical to today. `degraded` or a null
  // `billingAccountId` skips entirely (resolvePolicyForWorkspace's own
  // contract: not safe to enforce against possibly-wrong data). The
  // zero-spend `fetchMonthSpendUsd` stub matches the chat seat gate's own
  // (`applySeatGateForServedTurn`, `apps/console/lib/channel-dispatch.ts`) —
  // this gate never reads `policy.economics`, only
  // `monthlyCapacity`/`billingAccountId`/`degraded`, so paying for the real
  // ClickHouse fan-out on every claim poll (while the flag is on) is pure
  // waste. Any future reader of THIS resolution that starts touching
  // `policy.economics` must remove the stub first.
  //
  // Everything below lives inside ONE try/catch: §6's fail-open rule — a
  // thrown error anywhere here must never block a claim, only log loudly
  // (namespaced, matching every other best-effort block in this route) and
  // fall through to the wallet admission / normal claim path below.
  if (subscriptionsEnforced()) {
    try {
      const resolved = await resolvePolicyForWorkspace(workspaceId, {
        fetchMonthSpendUsd: async () => 0,
      });
      if (!resolved.degraded && resolved.billingAccountId) {
        const billingAccountId = resolved.billingAccountId;
        const { period, periodStartIso, periodEndIso } = currentBudgetWindow();
        const used = await countAccountRunsStartedInWindow(db, {
          billingAccountId,
          fromIso: periodStartIso,
          toIso: periodEndIso,
        });
        const capacity = resolved.policy.monthlyCapacity;
        if (used >= capacity) {
          // Fire-and-forget: the claim response never waits on chat
          // delivery — maybeNotifyCapacity owns its own error boundary (see
          // that function's own doc-comment).
          void maybeNotifyCapacity(billingAccountId, workspaceId, "capacity", period);
          return new NextResponse(null, {
            status: 204,
            headers: { [CLAIM_BLOCKED_HEADER]: "capacity" },
          });
        }
        if (used >= Math.ceil(capacity * 0.8)) {
          void maybeNotifyCapacity(billingAccountId, workspaceId, "capacity_warning", period);
        }
      }
    } catch (err) {
      console.error("[runner/claim] capacity gate failed open:", err);
    }
  }

  // Prepaid wallet admission (#1290 PR ①): when billing is enabled for this
  // workspace, a task is handed to a runner ONLY when the wallet balance
  // covers the alignment brief's pre-task estimate. Flag OFF (the default for
  // every workspace) short-circuits BEFORE any wallet read — today's behavior
  // byte-for-byte. When ON, peek the estimate of the entry this claim would
  // take next (the oldest queued, matching claimQueueEntry's own pick): a
  // NULL estimate (a brief-less / alignment-off row) is un-gateable and
  // admits; a covered estimate admits; an uncovered one blocks with a plain
  // 204 + the same X-Agentrail-Claim-Blocked header the budget gate uses
  // (value "wallet-balance"), never killing anything mid-run. Best-effort: a
  // wallet-read failure logs and falls through to a normal claim — a billing
  // hiccup must never strand a funded workspace's work, and the completion
  // charge (which may overrun into a negative balance) plus the NEXT
  // admission are the real accounting either way.
  if (await isBillingEnabled(workspaceId)) {
    try {
      const estimateUsd = await peekNextClaimEstimateUsd(workspaceId);
      if (
        estimateUsd !== null &&
        !(await walletCanAdmit(workspaceId, estimateUsd))
      ) {
        return new NextResponse(null, {
          status: 204,
          headers: { [CLAIM_BLOCKED_HEADER]: "wallet-balance" },
        });
      }
    } catch (err) {
      console.error("[runner/claim] wallet admission check failed:", err);
    }
  }

  const item = await claimQueueEntry(workspaceId);
  if (!item) {
    return new NextResponse(null, { status: 204 });
  }

  // Timeline state marker: the run has started (best-effort).
  await recordRunLifecycleEvent(
    workspaceId,
    item.id,
    "run_started",
    `Claimed ${item.external_id} — running locally`
  );

  // Hand the run its connected MCP keys (decrypted here, over the authenticated
  // link) so the runner can write the agent's MCP config into the cloned repo —
  // the codebase-level half of MCP connectors. Empty {} when none are connected.
  // Best-effort: a key-fetch hiccup must not block dispatching the work.
  let mcpKeys: Record<string, string> = {};
  try {
    mcpKeys = await getMcpConnectorKeys(workspaceId);
  } catch (err) {
    console.error("[runner/claim] failed to load MCP keys:", err);
  }

  // Hand the run a fresh GitHub App installation token so the runner can
  // authenticate `git clone`/`git push`/`gh pr create` for THIS workspace's
  // repo over the already-authenticated claim link — no separately configured
  // PAT required. "" when the workspace has no bound installation, the App
  // env is unconfigured, or GitHub is unreachable; the runner then falls back
  // to its own locally configured GIT_TOKEN, if any (back-compat).
  //
  // Installation tokens live ~1h (spec §2) and are minted fresh on EVERY
  // claim — there is nothing to refresh or cache here, unlike the OAuth token
  // this replaced. A run that legitimately outlives that hour is covered by
  // the existing push-401 → POST /api/v1/runner/refresh-github-token → retry
  // backstop (issue #1391), not by anything in this route. `getInstallationToken`
  // never throws (it swallows its own failures and returns null); the try/catch
  // here is defense-in-depth so a claim is never lost to this best-effort
  // lookup. Never logged: the token value never leaves this authenticated
  // response.
  let githubToken = "";
  try {
    githubToken = (await getInstallationToken(workspaceId)) ?? "";
  } catch (err) {
    console.error("[runner/claim] failed to resolve GitHub token:", err);
  }

  // Bot commit identity (spec §6): so pushed commits render as <slug>[bot]
  // instead of a neutral "AgentRail Runner" author. Composed from the same
  // App env the token mint above reads; omitted ENTIRELY (no key, not even
  // an empty string) when that env is unconfigured — a self-host running
  // without App credentials degrades to native_runner's own neutral fallback
  // identity rather than shipping empty/garbage values.
  const appCfg = resolveGithubAppConfig(process.env);
  const botIdentity = appCfg.ok
    ? botCommitIdentity(appCfg.slug, appCfg.botUserId)
    : null;

  return NextResponse.json({
    ...item,
    mcp_keys: mcpKeys,
    github_token: githubToken,
    ...(botIdentity
      ? { git_bot_name: botIdentity.name, git_bot_email: botIdentity.email }
      : {}),
  });
}

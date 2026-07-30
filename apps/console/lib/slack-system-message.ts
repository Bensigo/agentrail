/**
 * Console-side Slack SYSTEM sends (#1285, mirroring #1284's
 * `discord-system-message.ts` / #1262 PR ②'s `telegram-system-message.ts`) —
 * the multi-workspace "which one is this about?" ask and its pin
 * confirmation, sent straight via the Slack Web API (Eve never sees these —
 * they are not model turns).
 *
 * TEAM-SCOPED (Task 4, docs/superpowers/specs/2026-07-29-slack-multi-
 * workspace-design.md §4/§6): Slack issues a SEPARATE bot token per
 * workspace install, so there is no longer one shared token this module can
 * read from `process.env` — the `SLACK_BOT_TOKEN` read is GONE. Every call
 * now resolves the sending team's OWN token via `getSlackInstallation(teamId)`
 * (decrypted on read; `null` for an install that was never made, was
 * uninstalled, or was revoked — the query layer collapses all three so this
 * caller doesn't have to special-case any of them).
 *
 * FAIL LOUD, NEVER FALL BACK: a missing `teamId` or an unresolvable
 * installation returns a typed failure and logs the reason — it never falls
 * back to some OTHER team's token or to a since-removed shared default. This
 * is the one seam a mistake here would leak one customer's message being
 * posted with another customer's credential, so there is no silent-degrade
 * path.
 */
import { getSlackInstallation } from "@agentrail/db-postgres";
import { sendSlackChannelMessage, type SendResult } from "./slack-bot";

/**
 * Post a system (non-model) message to `channel` via the INSTALLING team's
 * own bot token. Returns a typed failure — never throws — when `teamId` is
 * missing/blank, when that team has no active installation (never installed,
 * uninstalled, or revoked), or when the send itself fails. Every failure
 * reason is also logged server-side (never the token) so a silently-dropped
 * system send is visible in the logs rather than only in the typed result.
 *
 * `threadTs`, when given, threads the send (final whole-branch review,
 * finding #1) — forwarded as-is to `sendSlackChannelMessage`'s own
 * `thread_ts`; omitted entirely for a DM, see that function's doc-comment.
 */
export async function sendSystemSlackMessage(
  teamId: string | undefined,
  channel: string,
  text: string,
  threadTs?: string
): Promise<SendResult> {
  const trimmedTeamId = teamId?.trim();
  if (!trimmedTeamId) {
    console.warn(
      "[slack-system-message] no Slack team id on this send — cannot resolve which installation's token to use; message not sent."
    );
    return { ok: false, error: "No Slack team id — cannot resolve installation." };
  }

  const installation = await getSlackInstallation(trimmedTeamId);
  if (!installation) {
    console.warn(
      `[slack-system-message] no active Slack installation for team ${trimmedTeamId} — ` +
        "never installed, uninstalled, or revoked; message not sent."
    );
    return { ok: false, error: "No active Slack installation for this team." };
  }

  return sendSlackChannelMessage(installation.botToken, channel, text, threadTs);
}

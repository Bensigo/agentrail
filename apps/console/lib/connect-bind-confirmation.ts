/**
 * Post-bind in-thread confirmation for `/connect/[token]` (issue #1263
 * PR ②): after a successful bind, tell the user in the SAME Telegram thread
 * that Jace can now act on their GitHub. Split out from the RSC page —
 * same reason as `connect-bind-decision.ts` (issue #1263 PR ①) — so the
 * "when do we confirm, and with what text" logic is unit-testable without a
 * database, a session, or a request.
 *
 * This is best-effort and MUST NOT be able to fail or delay the bind page's
 * own render: `sendConnectBindConfirmation` never rejects (every internal
 * step is caught), and the page itself calls it fire-and-forget with its own
 * `.catch` as a second, belt-and-suspenders guard (see page.tsx).
 */

import { latestTelegramSessionForChatIdentity } from "@agentrail/db-postgres";
import { sendSystemTelegramMessage } from "./telegram-system-message";
import type { ConnectIdentityBindDecision } from "./connect-bind-decision";

/**
 * Whether a completed `/connect/[token]` bind is worth confirming in-thread.
 * Send on `fresh_bind` (the identity just got linked to a user — a real
 * change, whether or not a workspace also got bound) or on `already_yours`
 * ONLY when it also carries a NEW workspace bind; a same-user, same-workspace
 * re-redemption (`already_yours` + `skip`) is a pure idempotent revisit —
 * nothing changed, so there is nothing to tell the user. `foreign_user` never
 * reaches here in practice (the page returns the expired/unknown screen
 * before computing a confirmation), but is handled defensively anyway: never
 * confirm a hijack attempt.
 *
 * Written as a type predicate so callers get `decision.workspaceDecision`
 * narrowed for free after checking this.
 */
export function shouldConfirmConnectBind(
  decision: ConnectIdentityBindDecision
): decision is Extract<
  ConnectIdentityBindDecision,
  { kind: "fresh_bind" | "already_yours" }
> {
  if (decision.kind === "foreign_user") return false;
  if (decision.kind === "fresh_bind") return true;
  return decision.workspaceDecision.action === "bind";
}

export interface BuildConnectBindConfirmationTextInput {
  accountLabel: string;
  workspaceName?: string;
}

/** Plain-text (no markdown) confirmation, matching telegram-system-message.ts's other builders. */
export function buildConnectBindConfirmationText(
  input: BuildConnectBindConfirmationTextInput
): string {
  const workspaceClause = input.workspaceName
    ? ` Workspace: ${input.workspaceName}.`
    : "";
  return `GitHub connected: ${input.accountLabel}.${workspaceClause} You can ask me to use it now.`;
}

export interface SendConnectBindConfirmationInput {
  chatIdentityId: string;
  decision: ConnectIdentityBindDecision;
  accountLabel: string;
}

/**
 * Send the post-bind confirmation into the identity's most recently active
 * Telegram session, or do nothing. Never throws/rejects — every step is
 * caught — so a DB blip or a Telegram-side failure can never propagate to a
 * caller that awaits this (defense in depth on top of the page's own
 * fire-and-forget `.catch`).
 *
 * Order of guards:
 *  1. `shouldConfirmConnectBind` — skip entirely (no session lookup, no
 *     send) for a pure idempotent revisit or a foreign_user.
 *  2. `latestTelegramSessionForChatIdentity` — skip silently when the
 *     identity has no Telegram session (e.g. bound from a non-telegram flow
 *     later); a lookup failure is caught and treated the same as "skip".
 *  3. Build the text (workspace clause only when THIS redemption just bound
 *     one — `decision.workspaceDecision.action === "bind"`) and send.
 *     `sendSystemTelegramMessage` already returns a typed `{ ok: false }`
 *     rather than rejecting on a known failure; the `.catch` below is the
 *     backstop for an unexpected throw so this function's own promise never
 *     rejects either way.
 */
export async function sendConnectBindConfirmation(
  input: SendConnectBindConfirmationInput
): Promise<void> {
  const { chatIdentityId, decision, accountLabel } = input;
  if (!shouldConfirmConnectBind(decision)) return;

  let session;
  try {
    session = await latestTelegramSessionForChatIdentity(chatIdentityId);
  } catch {
    return; // best-effort: a lookup failure must not surface past this helper
  }
  if (!session) return; // no telegram session for this identity — skip silently

  const workspaceName =
    decision.workspaceDecision.action === "bind"
      ? decision.workspaceDecision.workspace.name
      : undefined;
  const text = buildConnectBindConfirmationText({ accountLabel, workspaceName });

  await sendSystemTelegramMessage(session.conversationKey, text).catch(() => {
    // Best-effort: an unexpected throw/rejection from the send must not
    // propagate — sendSystemTelegramMessage's own typed { ok: false } path
    // already resolves normally, so this only guards a contract violation.
  });
}

/**
 * Post-sign-up in-thread confirmation (issue #1364, AC1's "Jace's flow
 * resumes in-thread"): after a magic-link sign-up redemption completes, tell
 * the user in the SAME Telegram thread so they can just keep talking rather
 * than needing to notice anything happened in the browser tab. Split out
 * from the redemption flow (`signup-redeem.ts`) for the same reason
 * `connect-bind-confirmation.ts` is split from `/connect/[token]/page.tsx`:
 * "when do we confirm, and with what text" is unit-testable without a
 * database or a request.
 *
 * Best-effort, same contract as `sendConnectBindConfirmation`: never
 * throws/rejects — a DB blip or Telegram-side failure must never surface to
 * a caller that awaits this.
 */

import { latestTelegramSessionForChatIdentity } from "@agentrail/db-postgres";
import { sendSystemTelegramMessage } from "./telegram-system-message";
import type { OwnerElectCompletionResult } from "./connect-owner-elect-completion";

export interface BuildSignupConfirmationTextInput {
  accountLabel: string;
  /** True iff this redemption ALSO completed owner-elect ownership of an
   * already-bound workspace (issue #1264's flow) — a legacy/edge path (see
   * `signup-redeem.ts`'s module comment on when `identity.workspaceId` can
   * already be set at sign-up time). Swaps the "ask me to set up your
   * workspace" invitation for a completed-ownership line, since there is
   * nothing left to set up. */
  ownershipCompleted?: boolean;
  workspaceName?: string | null;
}

/** Plain-text (no markdown), matching telegram-system-message.ts's other builders. */
export function buildSignupConfirmationText(
  input: BuildSignupConfirmationTextInput
): string {
  if (input.ownershipCompleted) {
    const workspaceClause = input.workspaceName ?? "this workspace";
    return `You're signed up, ${input.accountLabel}. You now own ${workspaceClause}.`;
  }
  return `You're signed up, ${input.accountLabel}. Ask me to set up your workspace and I'll pick up right here.`;
}

export interface SendSignupConfirmationInput {
  chatIdentityId: string;
  accountLabel: string;
  /** Owner-elect completion result from this same redemption, when there was
   * one to run (see `signup-redeem.ts`). Omitted (or `completed: false`)
   * renders the ordinary "ask me to set up your workspace" invitation. */
  ownerElectCompletion?: OwnerElectCompletionResult;
}

/**
 * Send the post-sign-up confirmation into the identity's most recently
 * active Telegram session, or do nothing. Never throws/rejects — every step
 * is caught — so a DB blip or a Telegram-side failure can never propagate to
 * a caller that awaits this (the redemption route also wraps this call in
 * its own fire-and-forget `.catch` as a second, belt-and-suspenders guard,
 * matching `/connect/[token]/page.tsx`'s posture for its own confirmation).
 */
export async function sendSignupConfirmation(
  input: SendSignupConfirmationInput
): Promise<void> {
  const { chatIdentityId, accountLabel, ownerElectCompletion } = input;

  let session;
  try {
    session = await latestTelegramSessionForChatIdentity(chatIdentityId);
  } catch {
    return; // best-effort: a lookup failure must not surface past this helper
  }
  if (!session) return; // no telegram session for this identity — skip silently

  const text = buildSignupConfirmationText({
    accountLabel,
    ownershipCompleted: ownerElectCompletion?.completed ?? false,
    workspaceName: ownerElectCompletion?.workspaceName ?? null,
  });

  await sendSystemTelegramMessage(session.conversationKey, text).catch(() => {
    // Best-effort: an unexpected throw/rejection from the send must not
    // propagate — sendSystemTelegramMessage's own typed { ok: false } path
    // already resolves normally, so this only guards a contract violation.
  });
}

import { db, getBillingAccountIdForWorkspace, claimSeat } from "@agentrail/db-postgres";

/**
 * Seat claim on invite accept (spec §5 rule 1, slice 4 Task 3:
 * "A seat is claimed automatically the first time a person accepts a
 * console invite into any workspace of the account" —
 * docs/superpowers/specs/2026-07-29-subscription-platform-design.md).
 *
 * SHARED by every entry point that calls `claimInvitesForUser` and gets
 * back the workspace ids it just inserted a membership row for — there are
 * two real ones, not one: `app/(auth)/invite/[token]/page.tsx` (a user
 * following an actual invite link) AND `app/(marketing)/page.tsx`'s
 * `LandingPage` (a signed-in user who lands on `/` instead — e.g. via the
 * nav/footer "Sign in with GitHub" path rather than an invite link — gets
 * the identical auto-claim-on-visit behavior already, wrapped in its own
 * try/catch before this hook existed). Same underlying `claimInvitesForUser`
 * call, same membership rows, same need to claim a seat for each — so the
 * hook lives here ONCE rather than being duplicated (and independently
 * tested, and independently drifting) at both call sites.
 *
 * `claimInvitesForUser` claims EVERY pending invite matching the caller's
 * email, not just one particular token's workspace, so a person with
 * pending invites into several workspaces can claim a seat for each
 * distinct billing account in one call here. Billing-account ids are
 * deduped into a Set first: `claimSeat`'s own `ON CONFLICT DO NOTHING`
 * already makes a repeat claim for the same account a harmless no-op, but
 * there's no reason to issue N redundant writes for the common case of
 * several workspaces on one account.
 *
 * NEVER THROWS — every DB call is individually try/caught and logged
 * loudly rather than left to bubble, same discipline as the chat-turn claim
 * hook (`channel-dispatch.ts`'s `claimSeatForServedTurn`, slice 4 Task 2):
 * a claim failure must never turn a successful invite accept (or a signed-
 * in landing-page visit) into a failed one. Callers can therefore just
 * `await` this with no `try`/`catch` of their own. A `null` billing account
 * id (a transitional workspace not yet bound to one) skips that workspace's
 * claim silently — same contract `getBillingAccountIdForWorkspace`'s own
 * doc-comment describes.
 */
export async function claimSeatsForAcceptedInvites(
  claimedWorkspaceIds: string[],
  userId: string
): Promise<void> {
  const billingAccountIdsToClaim = new Set<string>();
  for (const claimedWorkspaceId of claimedWorkspaceIds) {
    try {
      const billingAccountId = await getBillingAccountIdForWorkspace(
        db,
        claimedWorkspaceId
      );
      if (billingAccountId) {
        billingAccountIdsToClaim.add(billingAccountId);
      }
    } catch (err) {
      console.error(
        `[invite-accept] getBillingAccountIdForWorkspace failed (workspace=${claimedWorkspaceId}):`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  for (const billingAccountId of billingAccountIdsToClaim) {
    try {
      await claimSeat(db, {
        billingAccountId,
        subject: { userId },
        claimedVia: "console",
      });
    } catch (err) {
      console.error(
        `[invite-accept] claimSeat failed (billingAccount=${billingAccountId}, user=${userId}):`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
}

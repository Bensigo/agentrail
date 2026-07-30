import { notFound } from "next/navigation";
import { db, getBillingAccountForWorkspace, countActiveSeats } from "@agentrail/db-postgres";
import { getMembership, getSession } from "../../../../../lib/cached";
import { subscriptionBillingConfigured } from "../../../../../lib/billing/stripe-plans";
import { PageHeader } from "../../../../components/page-header";
import { CheckoutButtons } from "./components/checkout-buttons";
import { ManageBillingButton } from "./components/manage-billing-button";
import {
  canStartCheckout,
  planLabel,
  renewalLabel,
  seatLimitForPlan,
  seatsLabel,
  statusChip,
  STATUS_CHIP_TONE_CLASSNAME,
} from "./billing-helpers";

const ADMIN_ROLES = ["owner", "admin"] as const;

/**
 * Plan & billing settings page (slice-3 plan Task 5,
 * `docs/superpowers/plans/2026-07-29-subscription-stripe-slice3.md`).
 * Server component reading the queries directly (Wallet/Permissions page
 * precedent, `../wallet/page.tsx` / `../permissions/page.tsx`: no client
 * fetch, no new API route for the read half). Shows the current plan, its
 * subscription status (when Stripe has reported one), the renewal date, and
 * seats used against the plan's seat limit (`PLAN_POLICIES`) — never
 * AI-cost/dollars-spent-on-models language anywhere on this page
 * (subscription-platform spec §1 Principles): a customer sees their plan
 * and its value, not routing's internal accounting.
 *
 * No billing account is read exactly like a fresh trial, never an error —
 * `getBillingAccountForWorkspace`'s own doc-comment: "NULL exactly like a
 * fresh trial: no billing account yet is the default." A later slice's task
 * (trial billing account at workspace creation) guarantees one normally
 * exists by the time a human reaches this page; this still degrades
 * gracefully instead of 404ing if it doesn't — seats read as 0 (there is no
 * account id to count seat rows against) and the checkout/portal actions
 * below carry their own typed errors for this same case.
 *
 * `checkout` search param (`?checkout=success|cancelled`) is READ-ONLY, same
 * posture as `wallet/page.tsx`'s own doc-comment on its own `checkout`
 * param — it only decides which banner to show. It never writes plan state;
 * the plan/status/renewal rendered below always comes from
 * `billing_accounts`, written exclusively by the signature-verified webhook
 * (`api/v1/billing/stripe/webhook/route.ts`), never by this read or by the
 * checkout/portal redirect that lands here.
 */
export default async function BillingPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ checkout?: string }>;
}) {
  const { workspaceId } = await params;
  const { checkout } = await searchParams;

  const session = await getSession();
  if (!session?.user?.id) return notFound();

  const membership = await getMembership(session.user.id, workspaceId);
  if (!membership) return notFound();

  const account = await getBillingAccountForWorkspace(db, workspaceId);
  const seatsUsed = account ? await countActiveSeats(db, account.id) : 0;

  const canManage = ADMIN_ROLES.includes(
    membership.role as (typeof ADMIN_ROLES)[number]
  );
  const plan = account?.plan ?? "trial";
  const seatLimit = seatLimitForPlan(plan);
  const chip = statusChip(account?.subscriptionStatus ?? null);
  const billingConfigured = subscriptionBillingConfigured();

  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader title="Plan & billing" subtitle="Your subscription plan and seats." />

      <div className="flex flex-col gap-6">
        {checkout === "success" && (
          <div className="rounded border border-[var(--green-09)]/30 bg-[var(--green-09)]/10 p-3 text-sm text-[var(--green-11)]">
            Checkout completed. Once Stripe confirms the subscription the
            plan below updates automatically — refresh in a few seconds if
            it hasn&apos;t yet.
          </div>
        )}
        {checkout === "cancelled" && (
          <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-3 text-sm text-[var(--gray-11)]">
            Checkout was cancelled. No changes were made.
          </div>
        )}

        <div className="flex flex-col gap-3 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">
              Current plan
            </span>
            {chip && (
              <span
                className={`inline-flex w-fit items-center rounded-sm px-1.5 py-0.5 text-xs font-medium ${STATUS_CHIP_TONE_CLASSNAME[chip.tone]}`}
              >
                {chip.label}
              </span>
            )}
          </div>
          <span className="text-3xl font-bold text-[var(--gray-12)]">{planLabel(plan)}</span>
          <p className="text-sm text-[var(--gray-09)]">
            {renewalLabel(account?.currentPeriodEnd ?? null)}
          </p>
          <p className="text-sm text-[var(--gray-11)]">Seats: {seatsLabel(seatsUsed, seatLimit)}</p>
        </div>

        {/* Final whole-slice review, Critical: an already-subscribed account
            must not be offered a second, independent checkout — no account
            (never checked out) keeps today's behavior via the
            `{ stripeSubscriptionId: null }` fallback; `canStartCheckout`'s
            own doc-comment (`billing-helpers.ts`) has the full finding.
            `createSubscriptionCheckoutSessionAction` re-checks the same
            field server-side — this is the UI-hiding half only. */}
        {billingConfigured &&
          canStartCheckout(account ?? { stripeSubscriptionId: null }) && (
            <CheckoutButtons workspaceId={workspaceId} canManage={canManage} />
          )}

        {account && !canStartCheckout(account) && (
          <p className="text-sm text-[var(--gray-09)]">
            Plan changes and cancellation are handled through Manage billing.
          </p>
        )}

        {account?.stripeCustomerId && (
          <ManageBillingButton workspaceId={workspaceId} canManage={canManage} />
        )}
      </div>
    </div>
  );
}

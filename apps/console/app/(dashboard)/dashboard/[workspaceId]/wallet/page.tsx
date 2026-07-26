import { notFound } from "next/navigation";
import {
  getWalletBalanceCents,
  isBillingEnabled,
  listWalletTransactions,
} from "@agentrail/db-postgres";
import { getMembership, getSession } from "../../../../../lib/cached";
import { isStripeConfigured } from "../../../../../lib/stripe";
import { PageHeader } from "../../../../components/page-header";
import { TopUpForm } from "./components/top-up-form";
import { TransactionsTable } from "./components/transactions-table";
import { formatUsdCents, lowBalanceMessage } from "./wallet-helpers";

const ADMIN_ROLES = ["owner", "admin"] as const;

/**
 * Workspace Wallet page (#1415 AC1/AC2) — the prepaid balance + ledger, and
 * where a member with owner/admin rights tops up. Server component reading
 * the queries directly (Budget page precedent, `../budget/page.tsx`): no
 * client fetch, no new API route for the read half. Auth mirrors the sibling
 * workspace pages: the workspace layout already guards session +
 * membership, this re-checks defensively.
 *
 * `checkout` search param (`?checkout=success|cancelled`) is READ-ONLY — it
 * only decides which banner to show. It never credits anything; the wallet
 * balance rendered below always comes from the ledger's real SUM, not from
 * this param (see `wallet/actions.ts`'s doc-comment on why the
 * success-redirect can never be a write path).
 */
export default async function WalletPage({
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

  const [balanceUsdCents, transactions, billingEnabled] = await Promise.all([
    getWalletBalanceCents(workspaceId),
    listWalletTransactions(workspaceId),
    isBillingEnabled(workspaceId),
  ]);

  const canManage = ADMIN_ROLES.includes(
    membership.role as (typeof ADMIN_ROLES)[number]
  );
  const lowBalanceNotice = lowBalanceMessage(balanceUsdCents);

  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader
        title="Wallet"
        subtitle="The prepaid balance that funds the tasks Jace runs."
      />

      <div className="flex flex-col gap-6">
        {checkout === "success" && (
          <div className="rounded border border-[var(--green-09)]/30 bg-[var(--green-09)]/10 p-3 text-sm text-[var(--green-11)]">
            Checkout completed. Once Stripe confirms the payment the balance
            below updates automatically — refresh in a few seconds if it
            hasn&apos;t yet.
          </div>
        )}
        {checkout === "cancelled" && (
          <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-3 text-sm text-[var(--gray-11)]">
            Checkout was cancelled. No charge was made.
          </div>
        )}

        <div className="flex flex-col gap-3 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
          <span className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">
            Balance
          </span>
          <span
            className={`font-mono text-3xl font-bold ${
              balanceUsdCents < 0 ? "text-[var(--red-11)]" : "text-[var(--gray-12)]"
            }`}
          >
            {formatUsdCents(balanceUsdCents)}
          </span>
          {lowBalanceNotice && (
            <p className="text-sm text-[var(--red-11)]">{lowBalanceNotice}</p>
          )}
          {!billingEnabled && (
            <p className="text-xs text-[var(--gray-09)]">
              Billing turns on automatically once your first top-up is
              confirmed.
            </p>
          )}
        </div>

        <TopUpForm
          workspaceId={workspaceId}
          canManage={canManage}
          stripeConfigured={isStripeConfigured()}
        />

        <section className="flex flex-col gap-2">
          {/* Panel heading, not a th — bold per TASTE weight rule */}
          <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">
            Activity
          </h2>
          <TransactionsTable rows={transactions} />
        </section>
      </div>
    </div>
  );
}

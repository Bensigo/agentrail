"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getMembership, getSession } from "../../../../../lib/cached";
import { getStripeClient } from "../../../../../lib/stripe";
import { MAX_TOP_UP_USD_CENTS, MIN_TOP_UP_USD_CENTS } from "./top-up-constants";

/**
 * #1415 (Stripe top-up, Wave 5 / epic #1257; #1290's deferred PR ③) — the
 * owner/admin-gated "top up" action. Creates a Stripe Checkout Session for a
 * member-chosen amount and redirects the browser to it.
 *
 * This action NEVER credits the wallet — it only starts a Checkout Session.
 * The wallet is credited exclusively by the signature-verified webhook
 * (`api/v1/billing/stripe/webhook/route.ts`) once Stripe reports the payment
 * settled. Mirrors the repo's magic-link-over-chat rule: a GET/redirect flow
 * the browser controls can be replayed, back-buttoned, or spoofed, so it must
 * never be a write path for money.
 *
 * Auth follows this codebase's existing "owner OR admin" precedent for
 * billing/admin mutations (see `connectors/secret/route.ts`'s `ADMIN_ROLES`,
 * and the issue's own instruction to reuse that pattern rather than invent a
 * new one) — deliberately less restrictive than `permissions/actions.ts`'s
 * owner-only merge-permission gate, since topping up is adding money, not
 * granting write/merge trust.
 */
export type CreateTopUpCheckoutResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

const ADMIN_ROLES = ["owner", "admin"] as const;

/**
 * This deploy sets no `NEXTAUTH_URL`/`AUTH_URL`/`APP_URL` env (see
 * `connect-link/route.ts` and `lib/session-cookie.ts`'s own doc-comments on
 * the same gap) — Checkout's `success_url`/`cancel_url` need an absolute
 * origin, so this derives it from the request's own headers exactly like
 * those two call sites derive it from `request.url`, just via `next/headers`
 * since a Server Action has no `NextRequest` to read.
 */
async function resolveOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3001";
  const proto =
    h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export async function createTopUpCheckoutSessionAction(
  workspaceId: string,
  amountUsdCents: number
): Promise<CreateTopUpCheckoutResult> {
  // A Server Action is a real network endpoint (#1343 minor (d) precedent,
  // see permissions/actions.ts) — validate every argument at runtime even
  // though the client's own TS types already constrain it.
  if (typeof workspaceId !== "string" || !workspaceId) {
    return { ok: false, error: "Missing workspace." };
  }
  if (!Number.isInteger(amountUsdCents)) {
    return { ok: false, error: "Amount must be a whole number of cents." };
  }
  if (amountUsdCents < MIN_TOP_UP_USD_CENTS || amountUsdCents > MAX_TOP_UP_USD_CENTS) {
    return {
      ok: false,
      error: `Amount must be between $${(MIN_TOP_UP_USD_CENTS / 100).toFixed(2)} and $${(
        MAX_TOP_UP_USD_CENTS / 100
      ).toFixed(2)}.`,
    };
  }

  const session = await getSession();
  const userId = session?.user?.id;
  if (!userId) {
    return { ok: false, error: "Not signed in." };
  }

  const membership = await getMembership(userId, workspaceId);
  if (
    !membership ||
    !ADMIN_ROLES.includes(membership.role as (typeof ADMIN_ROLES)[number])
  ) {
    return { ok: false, error: "Only an owner or admin can top up the wallet." };
  }

  const stripe = getStripeClient();
  if (!stripe) {
    return {
      ok: false,
      error: "Billing isn't configured for this deployment yet.",
    };
  }

  const origin = await resolveOrigin();

  let checkoutUrl: string | null;
  try {
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: "AgentRail wallet top-up" },
            unit_amount: amountUsdCents,
          },
          quantity: 1,
        },
      ],
      // The webhook reads this metadata to know which workspace to credit
      // and how much — the ONLY place that number is decided; the webhook
      // never trusts a client-supplied amount, only what Stripe reports was
      // actually paid (session.amount_total), with this as a cross-check.
      metadata: { workspaceId, amountUsdCents: String(amountUsdCents) },
      success_url: `${origin}/dashboard/${workspaceId}/wallet?checkout=success`,
      cancel_url: `${origin}/dashboard/${workspaceId}/wallet?checkout=cancelled`,
    });
    checkoutUrl = checkoutSession.url;
  } catch (err) {
    console.error("[wallet] failed to create Stripe Checkout Session:", err);
    return { ok: false, error: "Couldn't start checkout. Try again in a moment." };
  }

  if (!checkoutUrl) {
    return { ok: false, error: "Stripe didn't return a checkout URL." };
  }

  // redirect() throws internally (Next.js's control-flow signal) — this
  // never returns past this line on the success path, matching this
  // codebase's server-action idiom of letting a genuine navigation escape
  // rather than round-tripping a URL back to the client to navigate itself.
  redirect(checkoutUrl);
}

import Stripe from "stripe";

/**
 * #1415 (Stripe top-up, Wave 5 / epic #1257; #1290's deferred PR ③) — the
 * one Stripe client this app instantiates. Mirrors this repo's existing env
 * convention (see `lib/fleet-auth.ts`, `lib/telegram-system-message.ts`): a
 * bare `process.env["STRIPE_SECRET_KEY"]` read at the point of use, no
 * central zod-validated env schema exists in this codebase to add to.
 *
 * Returns `null` when unconfigured (self-host / local dev without a Stripe
 * account) rather than throwing — every caller (the top-up action, the
 * webhook route) degrades gracefully instead of 500ing the whole page, same
 * posture as `_cta.ts`'s "never a dead link" env-gated CTA resolvers.
 */
let cachedClient: Stripe | null = null;
let cachedForKey: string | null = null;

export function getStripeClient(): Stripe | null {
  const key = process.env["STRIPE_SECRET_KEY"];
  if (!key) return null;
  if (cachedClient && cachedForKey === key) return cachedClient;
  cachedClient = new Stripe(key);
  cachedForKey = key;
  return cachedClient;
}

export function isStripeConfigured(): boolean {
  return !!process.env["STRIPE_SECRET_KEY"];
}

export function getStripeWebhookSecret(): string | undefined {
  return process.env["STRIPE_WEBHOOK_SECRET"];
}

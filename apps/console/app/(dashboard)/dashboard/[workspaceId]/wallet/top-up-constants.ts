/**
 * #1415 — top-up amount bounds, in integer cents. Split out of `actions.ts`
 * because a `"use server"` file may export ONLY async functions (Next.js
 * build error: "Only async functions are allowed to be exported in a 'use
 * server' file") — these plain constants need to be importable from both the
 * server action and the client form.
 *
 * ASSUMPTION (recalibrate later): a fat-finger guard, not a business-rule
 * ceiling — Stripe itself enforces the real payment-method limits.
 */
export const MIN_TOP_UP_USD_CENTS = 500; // $5.00
export const MAX_TOP_UP_USD_CENTS = 200_000; // $2,000.00

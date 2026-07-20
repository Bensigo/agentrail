/**
 * Gateway-first pricing policy (#1337 PR ②): given a model seat, resolve its
 * per-MTok rates from the live OpenRouter gateway snapshot FIRST, the
 * catalog's own PRICE_TABLE-mirrored constants SECOND — and record which one
 * won, so every cost/estimate record built on top of this stays auditable
 * (AC1: "any OpenRouter model id resolves to a real price... for both
 * estimates and metering").
 *
 * This is deliberately the ONE place TypeScript consumers ask "what does
 * this seat cost" — `estimate.ts` uses it today; #1338/#1339 (tiers/routing)
 * can reuse it rather than re-implementing the gateway-then-PRICE_TABLE
 * order themselves.
 */
import { getModelFromCatalog } from "./gateway-catalog";
import type { ModelSeat } from "./catalog";

/**
 * Shared vocabulary with the Python resolver
 * (`agentrail/run/pricing.py::_resolve_rates`): `"gateway"` = the live
 * OpenRouter snapshot had this slug; `"price_table"` = the canonical
 * PRICE_TABLE (mirrored here via a seat's own constants — see catalog.ts's
 * module doc) had it instead; `"fallback"` = neither did — the Python side's
 * neutral last-resort rate (`agentrail/context/pricing.py::_FALLBACK_RATE`).
 *
 * {@link resolveModelPrice} below never actually returns `"fallback"`: every
 * {@link ModelSeat} already carries its own PRICE_TABLE-mirrored constants
 * (catalog.test.ts's drift guard enforces this), so the price_table branch
 * always has a real number to fall back to — there is no third tier to fall
 * through to in THIS closed 4-seat keyspace. The value stays in the union
 * for parity with the Python side (which has a genuine no-rate-anywhere
 * case) and any future caller that resolves a seat with no baked-in
 * constant at all.
 */
export type PriceSource = "gateway" | "price_table" | "fallback";

export interface ResolvedPrice {
  inUsdPerMTok: number;
  outUsdPerMTok: number;
  priceSource: PriceSource;
}

/**
 * Resolve a seat's rates: the live gateway snapshot wins when it knows the
 * seat's slug; otherwise fall back to the seat's own PRICE_TABLE-mirrored
 * constants. Never a silent $0 — a seat's constants are always real,
 * positive, drift-guarded rates (see catalog.ts's "$0 hazard" note), so
 * there is no code path here that invents or defaults to zero.
 */
export function resolveModelPrice(seat: ModelSeat): ResolvedPrice {
  const gatewayEntry = getModelFromCatalog(seat.slug);
  if (gatewayEntry) {
    return {
      inUsdPerMTok: gatewayEntry.inUsdPerMTok,
      outUsdPerMTok: gatewayEntry.outUsdPerMTok,
      priceSource: "gateway",
    };
  }
  return {
    inUsdPerMTok: seat.inUsdPerMTok,
    outUsdPerMTok: seat.outUsdPerMTok,
    priceSource: "price_table",
  };
}

import { NextResponse } from "next/server";
import { getLandingStats } from "../../../../lib/landing-stats";

/**
 * Public landing stats (landing v2,
 * docs/superpowers/plans/2026-07-22-landing-v2.md §Task 9). No auth: the
 * payload is three platform-wide aggregate counts + a source tag — the same
 * numbers the landing page renders. Served from the shared hourly
 * `unstable_cache` read, with CDN cache headers on top so even a cache-miss
 * stampede costs one DB GROUP BY per hour per instance.
 */
export async function GET() {
  const stats = await getLandingStats();
  return NextResponse.json(stats, {
    headers: {
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { getAgentModelCosts } from "@agentrail/db-clickhouse";

// Canonical per-Mtok rates (mirror agentrail/context/pricing.py PRICE_TABLE).
// Used only to express the M026 signals in dollars; token signals need no rates.
const RATES: Record<string, { input: number; output: number; cachedRead: number }> = {
  "claude-fable-5": { input: 10, output: 50, cachedRead: 1 },
  "claude-opus-4-8": { input: 5, output: 25, cachedRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cachedRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cachedRead: 0.5 },
  "claude-opus-4-5": { input: 5, output: 25, cachedRead: 0.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cachedRead: 0.3 },
  "claude-sonnet-4-5": { input: 3, output: 15, cachedRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cachedRead: 0.1 },
};
const FALLBACK = { input: 3, output: 15, cachedRead: 0.3 };
const MTOK = 1_000_000;
// A model is "premium" if its input rate is well above the sonnet baseline —
// the routing signal: spend on premium models is where right-sizing can help.
const PREMIUM_INPUT_RATE = 5;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { workspaceId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const models = await getAgentModelCosts(workspaceId);

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheTokens = 0;
    let cachedDollarsSaved = 0;
    let outputCostUsd = 0;
    let premiumSpendUsd = 0;
    let estimate = false;

    const byModel = models.map((m) => {
      const rate = RATES[m.model] ?? ((estimate = true), FALLBACK);
      inputTokens += m.inputTokens;
      outputTokens += m.outputTokens;
      cacheTokens += m.cacheTokens;
      // cached-read costs (input - cachedRead) less than a normal input token
      cachedDollarsSaved += (m.cacheTokens * (rate.input - rate.cachedRead)) / MTOK;
      outputCostUsd += (m.outputTokens * rate.output) / MTOK;
      const premium = rate.input >= PREMIUM_INPUT_RATE;
      if (premium) premiumSpendUsd += m.totalCostUsd;
      return {
        model: m.model,
        runCount: m.runCount,
        totalCostUsd: m.totalCostUsd,
        cacheHitRate: m.inputTokens + m.cacheTokens > 0
          ? m.cacheTokens / (m.inputTokens + m.cacheTokens)
          : 0,
        outputInputRatio: m.inputTokens > 0 ? m.outputTokens / m.inputTokens : 0,
        premium,
      };
    });

    const promptTokens = inputTokens + cacheTokens;
    return NextResponse.json({
      cache: {
        hitRate: promptTokens > 0 ? cacheTokens / promptTokens : 0,
        cachedDollarsSaved,
        cacheTokens,
      },
      output: {
        outputInputRatio: inputTokens > 0 ? outputTokens / inputTokens : 0,
        outputCostUsd,
        outputTokens,
      },
      routing: {
        premiumSpendUsd,
        models: byModel,
      },
      estimate,
    });
  } catch (err) {
    console.error("[costs/optimization] failed:", err);
    return NextResponse.json(
      { error: "Failed to load optimization metrics" },
      { status: 500 }
    );
  }
}

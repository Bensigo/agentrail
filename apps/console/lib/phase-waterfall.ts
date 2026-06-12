/**
 * Phase waterfall derivation.
 *
 * Combines run events and cost rows into per-phase data suitable for
 * rendering a horizontal waterfall chart. Flags the slowest and most
 * expensive phase so the UI can highlight bottlenecks.
 */

export type PhaseEvent = {
  event_type: string;
  phase: string;
  occurred_at: string | Date;
};

export type CostRow = {
  phase: string;
  tokens: number;
  cost_usd: number;
};

export interface WaterfallPhase {
  /** Phase name as emitted by the CLI */
  name: string;
  /** Wall-clock duration in milliseconds (max - min across all events in the phase) */
  durationMs: number;
  /** Total tokens charged in this phase (0 if no cost row) */
  tokens: number;
  /** Total cost in USD for this phase (0 if no cost row) */
  costUsd: number;
  /** Share of total duration across all phases (0–1). 0 when total is 0. */
  share: number;
  /** True for the phase with the highest durationMs */
  isSlowest: boolean;
  /** True for the phase with the highest costUsd (ignores phases with 0 cost) */
  isMostExpensive: boolean;
}

function toMs(ts: string | Date): number {
  if (ts instanceof Date) return ts.getTime();
  return new Date(ts).getTime();
}

/**
 * Build a per-phase waterfall from run events and cost rows.
 *
 * @param events  All run events for the run (any event type with a phase label).
 * @param costRows  Cost rows from GET /runs/:id/costs, one row per phase.
 * @returns Phases sorted by their earliest event timestamp (ascending).
 *          Returns [] when events is empty.
 */
export function buildWaterfall(
  events: PhaseEvent[],
  costRows: CostRow[]
): WaterfallPhase[] {
  // Group event timestamps by lowercased phase name to avoid casing mismatches.
  const phaseTimestamps = new Map<string, { key: string; ms: number[] }>();
  for (const ev of events) {
    if (!ev.phase) continue;
    const key = ev.phase.toLowerCase();
    let entry = phaseTimestamps.get(key);
    if (!entry) {
      entry = { key: ev.phase, ms: [] };
      phaseTimestamps.set(key, entry);
    }
    const ms = toMs(ev.occurred_at);
    if (!Number.isNaN(ms)) entry.ms.push(ms);
  }

  if (phaseTimestamps.size === 0) return [];

  // Build cost lookup keyed by lowercase phase name.
  const costByPhase = new Map<string, { tokens: number; cost_usd: number }>();
  for (const row of costRows) {
    if (!row.phase) continue;
    const key = row.phase.toLowerCase();
    const existing = costByPhase.get(key);
    if (existing) {
      // Sum across multiple rows for the same phase (shouldn't happen but guard it).
      existing.tokens += row.tokens;
      existing.cost_usd += row.cost_usd;
    } else {
      costByPhase.set(key, { tokens: row.tokens, cost_usd: row.cost_usd });
    }
  }

  // Build phases sorted by earliest timestamp.
  const phases: Array<WaterfallPhase & { minMs: number }> = [];
  for (const [key, { key: name, ms }] of phaseTimestamps.entries()) {
    const minMs = Math.min(...ms);
    const maxMs = Math.max(...ms);
    const durationMs = maxMs - minMs;
    const cost = costByPhase.get(key);
    phases.push({
      name,
      durationMs,
      tokens: cost?.tokens ?? 0,
      costUsd: cost?.cost_usd ?? 0,
      share: 0, // filled in below
      isSlowest: false,
      isMostExpensive: false,
      minMs,
    });
  }

  phases.sort((a, b) => a.minMs - b.minMs);

  // Compute shares.
  const totalDuration = phases.reduce((sum, p) => sum + p.durationMs, 0);
  for (const p of phases) {
    p.share = totalDuration > 0 ? p.durationMs / totalDuration : 0;
  }

  // Flag bottlenecks.
  const maxDuration = Math.max(...phases.map((p) => p.durationMs));
  const maxCost = Math.max(...phases.map((p) => p.costUsd));

  for (const p of phases) {
    p.isSlowest = p.durationMs === maxDuration;
    // Only flag as most expensive when there is actual cost data.
    p.isMostExpensive = maxCost > 0 && p.costUsd === maxCost;
  }

  // Strip the internal minMs property before returning.
  return phases.map(({ minMs: _minMs, ...rest }) => rest);
}

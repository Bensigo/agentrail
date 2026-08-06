import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  executeCalls: [] as unknown[],
  executeRows: [] as Array<Array<Record<string, unknown>>>,
}));

vi.mock("../db.js", () => ({
  db: {
    execute: vi.fn(async (query: unknown) => {
      state.executeCalls.push(query);
      return state.executeRows.shift() ?? [];
    }),
  },
}));

import { PgDialect } from "drizzle-orm/pg-core";
import { readAcceptanceWorkspaceOutcomeSummary } from "./change_records.js";

const renderSql = (query: unknown) => new PgDialect().sqlToQuery(query as never);

const workspaceId = "ws-1";
const fromUtcInclusive = new Date("2026-08-01T00:00:00.000Z");
const toUtcExclusive = new Date("2026-08-02T00:00:00.000Z");

beforeEach(() => {
  state.executeCalls = [];
  state.executeRows = [];
});

describe("readAcceptanceWorkspaceOutcomeSummary", () => {
  it("counts windowed exact-head reviews, append-only human decisions, and current pending rows without legacy metrics tables", async () => {
    state.executeRows = [[{
      workspace_id: workspaceId,
      window_from_utc_inclusive: fromUtcInclusive,
      window_to_utc_exclusive: toUtcExclusive,
      counted_at_utc: new Date("2026-08-02T12:34:56.000Z"),
      reviewed_pr_revision_count: 3,
      proven_count: 2,
      not_proven_count: 1,
      other_jace_status_counts: { not_testable: 2, failed: 1 },
      approved_count: 4,
      changes_requested_count: 5,
      rejected_count: 6,
      approved_with_exception_count: 7,
      pending_queued_review_count: 8,
      pending_claimed_review_count: 9,
      pending_human_decision_count: 10,
    }]];

    const summary = await readAcceptanceWorkspaceOutcomeSummary({
      workspaceId,
      range: "24h",
      now: toUtcExclusive,
    });

    expect(summary).toEqual({
      workspaceId,
      windowFromUtcInclusive: fromUtcInclusive,
      windowToUtcExclusive: toUtcExclusive,
      countedAtUtc: new Date("2026-08-02T12:34:56.000Z"),
      reviewedPrRevisionCount: 3,
      jaceVerdicts: {
        proven: 2,
        notProven: 1,
        otherStatuses: { not_testable: 2, failed: 1 },
      },
      humanDecisions: {
        approved: 4,
        changesRequested: 5,
        rejected: 6,
        approvedWithException: 7,
      },
      pendingReviews: {
        queued: 8,
        claimed: 9,
        total: 17,
      },
      pendingHumanDecisions: 10,
    });

    expect(state.executeCalls).toHaveLength(1);
    const rendered = renderSql(state.executeCalls[0]);
    expect(rendered.sql).toContain("WITH windowed_reviews AS");
    expect(rendered.sql).toContain("windowed_decision_events AS");
    expect(rendered.sql).toContain("review.created_at >= $");
    expect(rendered.sql).toContain("review.created_at < $");
    expect(rendered.sql).toContain("event.at >= $");
    expect(rendered.sql).toContain("event.at < $");
    expect(rendered.sql).toContain("revision.superseded_at IS NULL");
    expect(rendered.sql).toContain("event.stage = 'human_pr_decision'");
    expect(rendered.sql).toContain("current_pending_human_reviews AS");
    expect(rendered.sql).toContain("request.status IN ('queued', 'claimed')");
    expect(rendered.sql).not.toContain("review_metrics");
    expect(rendered.sql).not.toContain("review_events");
    expect(rendered.params).toEqual(expect.arrayContaining([
      fromUtcInclusive.toISOString(),
      toUtcExclusive.toISOString(),
    ]));
    expect(rendered.params).not.toContain(fromUtcInclusive);
    expect(rendered.params).not.toContain(toUtcExclusive);
  });

  it("rejects an unsupported range or invalid server clock before issuing SQL", async () => {
    await expect(
      readAcceptanceWorkspaceOutcomeSummary({
        workspaceId,
        range: "7hours" as never,
      })
    ).rejects.toThrow("workspace outcome summary requires a supported range");
    await expect(
      readAcceptanceWorkspaceOutcomeSummary({
        workspaceId,
        range: "7d",
        now: new Date("not-a-date"),
      })
    ).rejects.toThrow("workspace outcome summary requires a valid current time");
    expect(state.executeCalls).toHaveLength(0);
  });

  it("uses a calendar-year server window for the one-year range", async () => {
    state.executeRows = [[{
      workspace_id: workspaceId,
      window_from_utc_inclusive: new Date("2025-03-01T00:00:00.000Z"),
      window_to_utc_exclusive: new Date("2026-03-01T00:00:00.000Z"),
      counted_at_utc: toUtcExclusive,
      reviewed_pr_revision_count: 0,
      proven_count: 0,
      not_proven_count: 0,
      other_jace_status_counts: {},
      approved_count: 0,
      changes_requested_count: 0,
      rejected_count: 0,
      approved_with_exception_count: 0,
      pending_queued_review_count: 0,
      pending_claimed_review_count: 0,
      pending_human_decision_count: 0,
    }]];

    await readAcceptanceWorkspaceOutcomeSummary({
      workspaceId,
      range: "1y",
      now: new Date("2026-03-01T00:00:00.000Z"),
    });

    const rendered = renderSql(state.executeCalls[0]);
    expect(rendered.params).toContain("2025-03-01T00:00:00.000Z");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as unknown[],
  updated: [] as unknown[],
  transaction: vi.fn(),
}));

vi.mock("../db.js", () => {
  const select = vi.fn(() => {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.innerJoin = () => chain;
    chain.where = async () => state.rows;
    return chain;
  });
  const update = vi.fn(() => {
    const chain: Record<string, unknown> = {};
    chain.set = () => chain;
    chain.where = () => chain;
    chain.returning = async () => state.updated;
    return chain;
  });
  return { db: { select, update, transaction: state.transaction } };
});

import { parseUiVerificationSteps, recordEvidenceVerificationPlans, reportEvidenceVerificationExecution } from "./change_records.js";

const input = {
  executionId: "execution", workerId: "worker", status: "proven" as const,
  observedBehavior: "widget was returned", artifactIds: ["artifact"],
};
const row = (modality: string, contentType: string) => ({
  execution: { id: "execution" },
  plan: { id: "plan", modality },
  artifact: { id: "artifact", contentType },
});

describe("reportEvidenceVerificationExecution proof modality", () => {
  beforeEach(() => {
    state.rows = [];
    state.updated = [{ id: "execution", status: "proven" }];
  });

  it("accepts a planned API criterion only with its JSON API proof", async () => {
    state.rows = [row("api", "application/json")];
    await expect(reportEvidenceVerificationExecution(input)).resolves.toEqual({ id: "execution", status: "proven" });
  });

  it("rejects a screenshot as proof of an API criterion", async () => {
    state.rows = [row("api", "image/png")];
    await expect(reportEvidenceVerificationExecution(input)).rejects.toThrow("requires JSON API evidence");
  });

  it("rejects an API card as proof of a UI criterion", async () => {
    state.rows = [row("ui", "application/json")];
    await expect(reportEvidenceVerificationExecution(input)).rejects.toThrow("requires PNG or JPEG evidence");
  });

  it.each(["job", "data"]) (
    "rejects %s proof instead of treating it as UI evidence",
    async (modality) => {
      state.rows = [row(modality, "image/png")];
      await expect(reportEvidenceVerificationExecution(input)).rejects.toThrow(
        `A proven ${modality} criterion is not supported`
      );
    }
  );
});

describe("recordEvidenceVerificationPlans planned modality validation", () => {
  beforeEach(() => {
    state.transaction.mockReset();
  });

  it.each(["job", "data"]) (
    "rejects planned %s before the query can persist it",
    async (modality) => {
      await expect(recordEvidenceVerificationPlans({
        workspaceId: "workspace",
        recordId: "record",
        prRevisionId: "revision",
        contractId: "contract",
        contractVersion: 1,
        plannedBy: "worker",
        plans: [{
          criterionId: "criterion",
          criterionTextSnapshot: "criterion",
          modality,
          expectedBehavior: "behavior",
          status: "planned",
        }],
      })).rejects.toThrow(
        `Cannot persist planned ${modality} verification plans; job/data must be explicitly marked not_testable until supported`
      );
      expect(state.transaction).not.toHaveBeenCalled();
    }
  );
});

describe("parseUiVerificationSteps", () => {
  it("accepts only bounded browser-user actions", () => {
    expect(parseUiVerificationSteps([
      { action: "open", path: "/drafts/new" },
      { action: "fill", selector: "[name=title]", value: "Release notes" },
      { action: "click", selector: "[data-testid=save]" },
      { action: "press", key: "Enter" },
      { action: "expect_text", text: "Saved" },
      { action: "screenshot", label: "saved-state" },
    ])).toMatchObject({ ok: true });
  });

  it.each([
    undefined,
    [],
    [{ action: "open", path: "https://outside.example" }],
    [{ action: "open", path: "//outside.example" }],
    [{ action: "web_fetch", url: "https://outside.example" }],
    [{ action: "click", selector: "button", script: "alert(1)" }],
    [{ action: "fill", selector: "[name=title]", value: "" }],
    [{ action: "press", key: "Control+L" }],
    Array.from({ length: 13 }, (_, index) => ({ action: "screenshot", label: `proof-${index}` })),
  ])("rejects unsafe or unbounded action input %#", (input) => {
    expect(parseUiVerificationSteps(input).ok).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ rows: [] as unknown[], updated: [] as unknown[] }));

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
  return { db: { select, update } };
});

import { reportEvidenceVerificationExecution } from "./change_records.js";

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
});

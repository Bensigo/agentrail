import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  readAcceptanceContracts: vi.fn(),
  recordEvidenceVerificationPlans: vi.fn(),
}));

import {
  readAcceptanceContracts,
  recordEvidenceVerificationPlans,
} from "@agentrail/db-postgres";
import { POST } from "./route";

const secret = "secret";
const contract = {
  id: "contract-1",
  version: 1,
  status: "confirmed",
  contract: {
    originalUserWording: "Show save",
    goal: "Save",
    acceptanceCriteria: [
      { id: "saved", text: "Saving shows confirmation", required: true, userVisible: true },
      { id: "audit", text: "Audit API records save", required: true, userVisible: false },
    ],
  },
};
const body = {
  workspaceId: "ws",
  recordId: "record",
  prRevisionId: "revision",
  contractId: "contract-1",
  contractVersion: 1,
  plannedBy: "worker",
  plans: [
    { criterionId: "saved", modality: "ui", status: "planned", environmentId: "preview-1", flow: "save a draft" },
    { criterionId: "audit", modality: "api", status: "not_testable", notTestableReason: "no safe credentials" },
  ],
};
const request = (value: unknown = body, auth = true) =>
  new NextRequest("http://localhost/api/v1/runner/evidence-verification-plans", {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { Authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify(value),
  });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JACE_CONSOLE_TOKEN = secret;
  vi.mocked(readAcceptanceContracts).mockResolvedValue([contract] as never);
  vi.mocked(recordEvidenceVerificationPlans).mockResolvedValue({
    inserted: true,
    plans: [
      { id: "plan-1", criterionId: "saved", modality: "ui", environmentId: "preview-1", flow: "save a draft", status: "planned" },
      { id: "plan-2", criterionId: "audit", modality: "api", environmentId: null, flow: null, status: "not_testable" },
    ],
  } as never);
});
describe("evidence verification plan completion", () => {
  it("persists every confirmed criterion plan before proof", async () => {
    const response = await POST(request());

    expect(response.status).toBe(201);
    expect(recordEvidenceVerificationPlans).toHaveBeenCalledWith(
      expect.objectContaining({
        plans: expect.arrayContaining([
          expect.objectContaining({
            criterionId: "saved",
            expectedBehavior: "Saving shows confirmation",
          }),
        ]),
      }),
    );
  });

  it("rejects a generic non-ui plan for a user-visible criterion", async () => {
    const response = await POST(request({
      ...body,
      plans: [{ ...body.plans[0], modality: "api" }, body.plans[1]],
    }));

    expect(response.status).toBe(400);
  });

  it("rejects a missing criterion or missing safe flow", async () => {
    expect((await POST(request({ ...body, plans: [body.plans[0]] }))).status).toBe(400);
    expect(
      (await POST(request({
        ...body,
        plans: [{ ...body.plans[0], flow: undefined }, body.plans[1]],
      }))).status,
    ).toBe(400);
  });

  it("fails closed without the worker secret", async () => {
    expect((await POST(request(body, false))).status).toBe(401);
    expect(recordEvidenceVerificationPlans).not.toHaveBeenCalled();
  });
});

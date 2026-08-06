import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  readAcceptanceContracts: vi.fn(),
  recordEvidenceVerificationPlans: vi.fn(),
  parseUiVerificationSteps: vi.fn((value: unknown) => {
    if (!Array.isArray(value) || value.length === 0) {
      return { ok: false, error: "uiSteps must be a non-empty action list" };
    }
    if (value.some((step) => step === null || typeof step !== "object" || Array.isArray(step))) {
      return { ok: false, error: "each uiStep must be an action object" };
    }
    return { ok: true, value };
  }),
  parseDataVerificationRequest: vi.fn((value: unknown) => {
    if (!value || typeof value !== "object") return { ok: false, error: "missing dataRequest" };
    return { ok: true, value };
  }),
}));

import {
  parseUiVerificationSteps,
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
    { criterionId: "saved", modality: "ui", status: "planned", environmentId: "preview-1", flow: "save a draft", uiSteps: [{ action: "open", path: "/drafts/new" }, { action: "fill", selector: "[name=title]", value: "Release notes" }, { action: "click", selector: "[data-testid=save]" }, { action: "expect_text", text: "Saved" }, { action: "screenshot", label: "saved-draft" }] },
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
      { id: "plan-1", criterionId: "saved", modality: "ui", environmentId: "preview-1", flow: "save a draft", uiSteps: body.plans[0].uiSteps, status: "planned" },
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
            uiSteps: body.plans[0].uiSteps,
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

  it.each([
    ["missing", undefined],
    ["unknown action", [{ action: "web_fetch", url: "https://outside.example" }]],
    ["extra payload", [{ action: "click", selector: "button", pageScript: "alert(1)" }]],
    ["unsafe path", [{ action: "open", path: "https://outside.example" }]],
    ["oversized selector", [{ action: "click", selector: "x".repeat(513) }]],
    ["over budget", Array.from({ length: 13 }, (_, index) => ({ action: "screenshot", label: `proof-${index}` }))],
  ])("rejects %s uiSteps", async (_name, uiSteps) => {
    vi.mocked(parseUiVerificationSteps).mockReturnValueOnce({
      ok: false,
      error: "uiSteps contains an unknown, unsafe, oversized, or extra-payload action",
    });
    const response = await POST(request({
      ...body,
      plans: [{ ...body.plans[0], uiSteps }, body.plans[1]],
    }));

    expect(response.status).toBe(400);
    expect(recordEvidenceVerificationPlans).not.toHaveBeenCalled();
  });

  it("uses the parser result rather than persisting an unparsed UI action list", async () => {
    await POST(request());

    expect(parseUiVerificationSteps).toHaveBeenCalledWith(body.plans[0].uiSteps);
  });

  it("requires a bounded read-only descriptor for a planned API criterion", async () => {
    const apiPlan = { criterionId: "audit", modality: "api", status: "planned", environmentId: "preview-1", flow: "read audit", apiRequest: { method: "GET", path: "/api/audit", expectedStatus: 200 } };
    expect((await POST(request({ ...body, plans: [body.plans[0], apiPlan] }))).status).toBe(201);
    expect((await POST(request({ ...body, plans: [body.plans[0], { ...apiPlan, apiRequest: { method: "POST", path: "/api/audit", expectedStatus: 200 } }] }))).status).toBe(400);
    expect((await POST(request({ ...body, plans: [body.plans[0], { ...apiPlan, apiRequest: { method: "GET", path: "https://outside.example", expectedStatus: 200 } }] }))).status).toBe(400);
  });

  it("rejects a planned job criterion without a safe executor", async () => {
    const modality = "job";
    const response = await POST(request({
      ...body,
      plans: [body.plans[0], { criterionId: "audit", modality, status: "planned", environmentId: "preview-1", flow: "inspect audit" }],
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: `planned criterion audit with modality ${modality} has no supported safe executor and must be recorded as not_testable with a concrete reason`,
    });
    expect(recordEvidenceVerificationPlans).not.toHaveBeenCalled();
  });

  it.each(["job", "data"])("accepts a not_testable %s criterion with a concrete reason", async (modality) => {
    const response = await POST(request({
      ...body,
      plans: [body.plans[0], { criterionId: "audit", modality, status: "not_testable", notTestableReason: `No safe ${modality} executor is configured` }],
    }));

    expect(response.status).toBe(201);
    expect(recordEvidenceVerificationPlans).toHaveBeenCalledWith(expect.objectContaining({
      plans: expect.arrayContaining([expect.objectContaining({
        criterionId: "audit",
        modality,
        status: "not_testable",
        notTestableReason: `No safe ${modality} executor is configured`,
      })]),
    }));
  });

  it("fails closed without the worker secret", async () => {
    expect((await POST(request(body, false))).status).toBe(401);
    expect(recordEvidenceVerificationPlans).not.toHaveBeenCalled();
  });
});

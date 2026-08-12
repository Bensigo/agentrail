import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getJaceSessionByEveSessionId: vi.fn(),
  readAcceptanceContracts: vi.fn(),
  readAcceptanceIntake: vi.fn(),
  recordApprovalRequest: vi.fn(),
  validateAcceptanceContract: vi.fn(),
}));
vi.mock("../../../../../lib/approval-message", () => ({ renderApprovalMessage: vi.fn() }));
vi.mock("../../workspaces/[workspaceId]/connectors/secret/telegram", () => ({
  buildApprovalKeyboard: vi.fn(),
  sendTelegramMessage: vi.fn(),
}));

import {
  getJaceSessionByEveSessionId,
  readAcceptanceContracts,
  readAcceptanceIntake,
  recordApprovalRequest,
  validateAcceptanceContract,
} from "@agentrail/db-postgres";
import { POST } from "./route";

const SECRET = "test-jace-console-token";
const session = {
  id: "session-1",
  workspaceId: "workspace-1",
  chatIdentityId: "identity-1",
  channel: "slack",
  conversationKey: "thread-1",
};
const draft = {
  id: "contract-1",
  recordId: "record-1",
  version: 2,
  status: "draft",
  createdAt: new Date("2026-08-06T10:00:00.000Z"),
  contract: {
    originalRequest: "Add saved filters",
    normalizedRequirements: ["Users can save filters"],
    acceptanceCriteria: [
      { id: "AC-1", text: "A user can save a filter", userVisible: true },
    ],
    nonGoals: [],
    risks: [],
    environment: { kind: "existing_preview" },
    stops: [],
    unresolvedQuestions: [],
  },
};

function request(body: unknown, authorized = true) {
  return new NextRequest("http://localhost/api/v1/runner/acceptance-contract-approvals", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorized ? { Authorization: `Bearer ${SECRET}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env["JACE_CONSOLE_TOKEN"] = SECRET;
  vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(session as never);
  vi.mocked(readAcceptanceContracts).mockResolvedValue([draft] as never);
  vi.mocked(readAcceptanceIntake).mockResolvedValue({
    intake: { recordId: "record-1" },
    messages: [{ direction: "inbound", sourceKey: "message-2", createdAt: new Date("2026-08-06T10:02:00.000Z") }],
  } as never);
  vi.mocked(validateAcceptanceContract).mockReturnValue({ ok: true });
  vi.mocked(recordApprovalRequest).mockResolvedValue({
    created: true,
    approval: { id: "approval-1", status: "pending", callbackToken: "callback-1" },
  } as never);
});

describe("POST /api/v1/runner/acceptance-contract-approvals", () => {
  const body = {
    eveSessionId: "eve-1",
    recordId: "record-1",
    acceptanceContractId: "contract-1",
    idempotencyKey: "eve-1:contract-1:v2",
  };

  it("persists a server-resolved draft binding rather than caller-authored contract content", async () => {
    const response = await POST(request({ ...body, contract: { fake: true } }));

    expect(response.status).toBe(201);
    expect(readAcceptanceContracts).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      recordId: "record-1",
    });
    expect(recordApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        toolName: "confirm_acceptance_contract",
        acceptanceContractId: "contract-1",
        toolInput: expect.objectContaining({
          kind: "acceptance_contract_confirmation",
          recordId: "record-1",
          acceptanceContractId: "contract-1",
          version: 2,
          acceptanceCriteria: [
            { id: "AC-1", text: "A user can save a filter", userVisible: true },
          ],
        }),
      })
    );
  });

  it("fails closed for a session without a workspace", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({ ...session, workspaceId: null } as never);
    const response = await POST(request(body));
    expect(response.status).toBe(404);
    expect(readAcceptanceContracts).not.toHaveBeenCalled();
    expect(recordApprovalRequest).not.toHaveBeenCalled();
  });

  it("fails closed when the contract is foreign, stale, or already confirmed", async () => {
    vi.mocked(readAcceptanceContracts).mockResolvedValue([{ ...draft, id: "contract-other" }] as never);
    const response = await POST(request(body));
    expect(response.status).toBe(404);
    expect(recordApprovalRequest).not.toHaveBeenCalled();
  });

  it("does not ask for confirmation when required Contract fields are missing", async () => {
    vi.mocked(validateAcceptanceContract).mockReturnValue({
      ok: false,
      errors: ["acceptanceCriteria"],
    });
    vi.mocked(readAcceptanceContracts).mockResolvedValue([
      { ...draft, contract: { acceptanceCriteria: [], unresolvedQuestions: [] } },
    ] as never);
    const response = await POST(request(body));
    expect(response.status).toBe(409);
    expect(recordApprovalRequest).not.toHaveBeenCalled();
  });

  it("returns an existing approval on an idempotent retry without a second notification", async () => {
    vi.mocked(recordApprovalRequest).mockResolvedValue({
      created: false,
      approval: { id: "approval-1", status: "approved", callbackToken: "callback-1" },
    } as never);
    const response = await POST(request(body));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ approvalId: "approval-1", status: "approved" });
  });

  it("derives the approval binding from the trusted Intake and post-draft source message", async () => {
    const response = await POST(request({
      eveSessionId: "eve-1",
      intakeId: "intake-1",
      version: 2,
      confirmationSourceKey: "message-2",
    }));

    expect(response.status).toBe(201);
    expect(readAcceptanceIntake).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      intakeId: "intake-1",
    });
    expect(recordApprovalRequest).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "acceptance-intake:intake-1:contract:2",
      acceptanceContractId: "contract-1",
    }));
  });

  it("rejects a pre-draft Intake source message before recording approval", async () => {
    vi.mocked(readAcceptanceIntake).mockResolvedValue({
      intake: { recordId: "record-1" },
      messages: [{ direction: "inbound", sourceKey: "message-2", createdAt: new Date("2026-08-06T09:59:00.000Z") }],
    } as never);
    const response = await POST(request({
      eveSessionId: "eve-1",
      intakeId: "intake-1",
      version: 2,
      confirmationSourceKey: "message-2",
    }));

    expect(response.status).toBe(409);
    expect(recordApprovalRequest).not.toHaveBeenCalled();
  });
});

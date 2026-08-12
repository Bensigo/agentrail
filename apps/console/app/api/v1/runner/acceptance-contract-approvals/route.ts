import { NextRequest, NextResponse } from "next/server";
import {
  getJaceSessionByEveSessionId,
  readAcceptanceContracts,
  recordApprovalRequest,
  validateAcceptanceContract,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";
import { renderApprovalMessage } from "../../../../../lib/approval-message";
import {
  buildApprovalKeyboard,
  sendTelegramMessage,
} from "../../workspaces/[workspaceId]/connectors/secret/telegram";

type ConfirmationRequest = {
  eveSessionId: string;
  recordId: string;
  acceptanceContractId: string;
  idempotencyKey: string;
};

function isConfirmationRequest(value: unknown): value is ConfirmationRequest {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return (
    typeof body["eveSessionId"] === "string" &&
    body["eveSessionId"].length > 0 &&
    typeof body["recordId"] === "string" &&
    body["recordId"].length > 0 &&
    typeof body["acceptanceContractId"] === "string" &&
    body["acceptanceContractId"].length > 0 &&
    typeof body["idempotencyKey"] === "string" &&
    body["idempotencyKey"].length > 0
  );
}

function isConfirmableContract(contract: Record<string, unknown>): boolean {
  const unresolvedQuestions = contract["unresolvedQuestions"];
  return (
    validateAcceptanceContract(contract).ok &&
    Array.isArray(unresolvedQuestions) &&
    unresolvedQuestions.length === 0
  );
}

async function notifyOriginatingChannel(input: {
  channel: string;
  conversationKey: string;
  callbackToken: string;
  toolInput: Record<string, unknown>;
}): Promise<void> {
  if (input.channel !== "telegram") return;
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) {
    console.error(
      "[acceptance-contract-approvals] TELEGRAM_BOT_TOKEN is not configured; approval recorded without a channel notification"
    );
    return;
  }
  try {
    const result = await sendTelegramMessage(
      token,
      input.conversationKey,
      renderApprovalMessage("confirm_acceptance_contract", input.toolInput),
      buildApprovalKeyboard(input.callbackToken)
    );
    if (!result.ok) {
      console.error("[acceptance-contract-approvals] Telegram send failed:", result.error);
    }
  } catch (error) {
    console.error("[acceptance-contract-approvals] unexpected Telegram send error:", error);
  }
}

/**
 * Creates the one human approval that may confirm a persisted Acceptance
 * Contract version. Unlike the generic runner approval endpoint, this route
 * does not accept a model-authored tool payload: it resolves the session,
 * record, and draft contract on the server and persists that exact binding.
 */
export async function POST(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!isConfirmationRequest(body)) {
    return NextResponse.json(
      {
        error:
          "Body must have eveSessionId, recordId, acceptanceContractId, and idempotencyKey strings",
      },
      { status: 400 }
    );
  }

  const session = await getJaceSessionByEveSessionId(body.eveSessionId);
  if (!session?.workspaceId) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const contracts = await readAcceptanceContracts({
    workspaceId: session.workspaceId,
    recordId: body.recordId,
  });
  const contract = contracts?.find((item) => item.id === body.acceptanceContractId);
  if (!contract || contract.status !== "draft") {
    return NextResponse.json({ error: "Acceptance Contract not found" }, { status: 404 });
  }
  if (!isConfirmableContract(contract.contract)) {
    return NextResponse.json(
      { error: "Acceptance Contract has unresolved or missing confirmation fields" },
      { status: 409 }
    );
  }

  const toolInput = {
    kind: "acceptance_contract_confirmation",
    recordId: body.recordId,
    acceptanceContractId: contract.id,
    version: contract.version,
    // This is a server-selected view of the persisted draft. It gives the
    // human enough of the Contract to make a decision without turning the
    // approval request into another model-authored source of truth.
    title:
      typeof contract.contract["title"] === "string"
        ? contract.contract["title"]
        : undefined,
    goal:
      typeof contract.contract["goal"] === "string"
        ? contract.contract["goal"]
        : typeof contract.contract["originalRequest"] === "string"
          ? contract.contract["originalRequest"]
          : undefined,
    acceptanceCriteria: Array.isArray(contract.contract["acceptanceCriteria"])
      ? contract.contract["acceptanceCriteria"]
      : [],
    nonGoals: Array.isArray(contract.contract["nonGoals"])
      ? contract.contract["nonGoals"]
      : [],
  };
  const { approval, created } = await recordApprovalRequest({
    workspaceId: session.workspaceId,
    chatIdentityId: session.chatIdentityId ?? undefined,
    sessionId: session.id,
    eveSessionId: body.eveSessionId,
    requestId: body.idempotencyKey,
    toolName: "confirm_acceptance_contract",
    toolInput,
    approveOptionId: "approve",
    denyOptionId: "deny",
    acceptanceContractId: contract.id,
  });

  if (created) {
    await notifyOriginatingChannel({
      channel: session.channel,
      conversationKey: session.conversationKey,
      callbackToken: approval.callbackToken,
      toolInput,
    });
  }

  return NextResponse.json(
    { approvalId: approval.id, status: approval.status },
    { status: created ? 201 : 200 }
  );
}

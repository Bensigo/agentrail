import { resolveBoundAcceptanceIntake } from "./acceptance_intake_draft.core.mjs";

export function acceptanceIntakeConfirmPath(intakeId) {
  return "/api/v1/runner/acceptance-contract-approvals";
}

function failed(reason, extra = {}) {
  return { ok: false, degraded: true, reason, ...extra };
}

/** Confirm a draft only from the current trusted inbound channel message. */
export async function confirmAcceptanceContractFromBoundIntake({ sessionAuth, eveSessionId, version, env = {}, transport }) {
  const binding = resolveBoundAcceptanceIntake(sessionAuth);
  if (!binding.ok) return failed(binding.reason);
  const sessionId = String(eveSessionId ?? "").trim();
  if (!sessionId) return failed("missing_session_id");
  const attributes = sessionAuth?.current?.attributes ?? sessionAuth?.initiator?.attributes;
  const sourceKey = String(attributes?.acceptanceInboundSourceKey ?? "").trim();
  if (!sourceKey) return failed("missing_confirmation_turn_binding");
  if (!Number.isInteger(version) || version < 1) return failed("invalid_contract_version");
  const baseUrl = String(env.JACE_CONSOLE_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const token = String(env.JACE_CONSOLE_TOKEN ?? "").trim();
  if (!baseUrl || !token) return failed("console_not_configured");
  let response;
  try {
    response = await transport(`${baseUrl}${acceptanceIntakeConfirmPath(binding.intakeId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        eveSessionId: sessionId,
        intakeId: binding.intakeId,
        version,
        confirmationSourceKey: sourceKey,
      }),
    });
  } catch {
    return failed("console_unreachable");
  }
  const status = Number(response?.status);
  if (status < 200 || status >= 300) {
    const reason = status === 400 ? "invalid_confirmation" :
      status === 401 || status === 403 ? "console_unauthorized" :
      status === 404 ? "intake_not_found" :
      status === 409 ? "confirmation_refused" :
      status >= 500 ? "console_error" : "console_unexpected_status";
    return failed(reason, { status });
  }
  let payload;
  try { payload = await response.json(); } catch { return failed("console_invalid_response", { status }); }
  const approvalId = String(payload?.approvalId ?? "").trim();
  const approvalStatus = String(payload?.status ?? "").trim();
  if (!approvalId || !approvalStatus) {
    return failed("console_invalid_response", { status });
  }
  return {
    ok: true,
    intakeId: binding.intakeId,
    approval: { id: approvalId, status: approvalStatus },
    note: "Acceptance Contract approval requested. The human approval must resolve before Context Pack compilation or builder handoff.",
  };
}

import { resolveBoundAcceptanceIntake } from "./acceptance_intake_draft.core.mjs";

export function acceptanceIntakeConfirmPath(intakeId) {
  return `/api/v1/runner/acceptance-intakes/${encodeURIComponent(String(intakeId))}/confirm`;
}

function failed(reason, extra = {}) {
  return { ok: false, degraded: true, reason, ...extra };
}

/** Confirm a draft only from the current trusted inbound channel message. */
export async function confirmAcceptanceContractFromBoundIntake({ sessionAuth, version, env = {}, transport }) {
  const binding = resolveBoundAcceptanceIntake(sessionAuth);
  if (!binding.ok) return failed(binding.reason);
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
      body: JSON.stringify({ workspaceId: binding.workspaceId, version, confirmationSourceKey: sourceKey }),
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
  const contractId = String(payload?.contract?.id ?? "").trim();
  const confirmedVersion = Number(payload?.contract?.version);
  if (!contractId || !Number.isInteger(confirmedVersion) || payload?.contract?.status !== "confirmed") {
    return failed("console_invalid_response", { status });
  }
  return {
    ok: true,
    intakeId: binding.intakeId,
    contract: { id: contractId, version: confirmedVersion, status: "confirmed" },
    note: "The human-confirmed Acceptance Contract is recorded. Context Pack compilation and builder handoff remain separate steps.",
  };
}

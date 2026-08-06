// Transport boundary for turning the acceptance intake bound to this Eve
// session into a *draft* Acceptance Record. The model never supplies a tenant
// or intake identifier: both come from the trusted hosted-channel session.

export function resolveBoundAcceptanceIntake(sessionAuth) {
  const attributes = sessionAuth?.current?.attributes ?? sessionAuth?.initiator?.attributes;
  if (!attributes || typeof attributes !== "object") return { ok: false, reason: "missing_session_binding" };
  const workspaceId = String(attributes.workspaceId ?? "").trim();
  const intakeId = String(attributes.acceptanceIntakeId ?? "").trim();
  if (!workspaceId) return { ok: false, reason: "missing_workspace_binding" };
  if (!intakeId) return { ok: false, reason: "missing_intake_binding" };
  return { ok: true, workspaceId, intakeId };
}

export function resolveAcceptanceIntakeDraftConfig(env = {}) {
  const baseUrl = String(env.JACE_CONSOLE_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const token = String(env.JACE_CONSOLE_TOKEN ?? "").trim();
  if (!baseUrl || !token) return { ok: false, reason: "console_not_configured" };
  return { ok: true, baseUrl, token };
}

export function acceptanceIntakeDraftPath(intakeId) {
  return `/api/v1/runner/acceptance-intakes/${encodeURIComponent(intakeId)}/draft`;
}

function failed(reason, extra = {}) {
  return { ok: false, degraded: true, reason, ...extra };
}

/**
 * Create a draft only. Confirmation, context compilation, builder handoff,
 * implementation, and execution remain separate human- or runner-owned
 * lifecycle steps.
 */
export async function draftAcceptanceContractFromBoundIntake({ sessionAuth, repo, contract, env = {}, transport }) {
  const binding = resolveBoundAcceptanceIntake(sessionAuth);
  if (!binding.ok) return failed(binding.reason);
  const repoName = String(repo ?? "").trim();
  if (!repoName) return failed("missing_repo");
  const config = resolveAcceptanceIntakeDraftConfig(env);
  if (!config.ok) return failed(config.reason);

  let response;
  try {
    response = await transport(`${config.baseUrl}${acceptanceIntakeDraftPath(binding.intakeId)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({ workspaceId: binding.workspaceId, repo: repoName, contract }),
    });
  } catch {
    return failed("console_unreachable");
  }

  const status = Number(response?.status);
  if (status < 200 || status >= 300) {
    const reason = status === 400 ? "invalid_contract" :
      status === 401 || status === 403 ? "console_unauthorized" :
      status === 404 ? "intake_not_found" :
      status === 409 ? "intake_already_linked" :
      status >= 500 ? "console_error" : "console_unexpected_status";
    return failed(reason, { status });
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return failed("console_invalid_response", { status });
  }
  const recordId = String(payload?.record?.id ?? "").trim();
  const contractId = String(payload?.contract?.id ?? "").trim();
  if (!recordId || !contractId) return failed("console_invalid_response", { status });
  return {
    ok: true,
    intakeId: binding.intakeId,
    record: { id: recordId, repo: String(payload.record.repo ?? repoName).trim() || repoName },
    contract: {
      id: contractId,
      version: Number.isInteger(payload.contract.version) ? payload.contract.version : null,
      status: String(payload.contract.status ?? "draft"),
    },
    note: "Acceptance Contract is drafted only. It still needs explicit human confirmation before Context Pack handoff or implementation.",
  };
}

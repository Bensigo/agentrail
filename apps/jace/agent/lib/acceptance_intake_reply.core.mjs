// Pure transport boundary for recording a Jace reply after the channel has
// successfully delivered it. Tenant and Intake identity come only from Eve's
// bound session auth; this is not a model-facing tool and never accepts either
// identity as conversational input.

export function resolveBoundAcceptanceReply(sessionAuth) {
  const attributes = sessionAuth?.current?.attributes ?? sessionAuth?.initiator?.attributes;
  if (!attributes || typeof attributes !== "object") return { ok: false, reason: "missing_session_binding" };
  const workspaceId = String(attributes.workspaceId ?? "").trim();
  const intakeId = String(attributes.acceptanceIntakeId ?? "").trim();
  if (!workspaceId) return { ok: false, reason: "missing_workspace_binding" };
  if (!intakeId) return { ok: false, reason: "missing_intake_binding" };
  return { ok: true, workspaceId, intakeId };
}

export function acceptanceIntakeMessagesPath(intakeId) {
  return `/api/v1/runner/acceptance-intakes/${encodeURIComponent(intakeId)}/messages`;
}

function config(env = {}) {
  const baseUrl = String(env.JACE_CONSOLE_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const token = String(env.JACE_CONSOLE_TOKEN ?? "").trim();
  return baseUrl && token
    ? { ok: true, baseUrl, token }
    : { ok: false, reason: "console_not_configured" };
}

function degraded(reason, extra = {}) {
  return { ok: false, degraded: true, reason, ...extra };
}

/**
 * Records one already-delivered reply. A failure is returned, not thrown, so
 * callers cannot turn an audit write failure into a channel delivery failure.
 */
export async function recordDeliveredAcceptanceReply({
  sessionAuth,
  sourceKey,
  text,
  metadata,
  env = {},
  transport,
}) {
  const binding = resolveBoundAcceptanceReply(sessionAuth);
  if (!binding.ok) return degraded(binding.reason);
  const key = String(sourceKey ?? "").trim();
  const message = String(text ?? "").trim();
  if (!key) return degraded("missing_source_key");
  if (!message) return degraded("missing_reply_text");
  const cfg = config(env);
  if (!cfg.ok) return degraded(cfg.reason);

  let response;
  try {
    response = await transport(`${cfg.baseUrl}${acceptanceIntakeMessagesPath(binding.intakeId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({ workspaceId: binding.workspaceId, sourceKey: key, text: message, metadata: metadata ?? {} }),
    });
  } catch {
    return degraded("console_unreachable");
  }

  const status = Number(response?.status);
  if (status < 200 || status >= 300) {
    return degraded(status === 401 || status === 403 ? "console_unauthorized" :
      status === 404 ? "intake_not_found" : status === 409 ? "source_key_conflict" :
      status >= 500 ? "console_error" : "console_unexpected_status", { status });
  }
  let payload;
  try { payload = await response.json(); } catch { return degraded("console_invalid_response", { status }); }
  const messageId = String(payload?.message?.id ?? "").trim();
  if (!messageId) return degraded("console_invalid_response", { status });
  return { ok: true, intakeId: binding.intakeId, messageId, inserted: payload.inserted === true };
}

/**
 * Builds one idempotent source key for a completed Eve turn. A reply must not
 * be recorded without both values: session alone spans a conversation, while
 * turn alone is not globally scoped. Neither is model input.
 */
export function acceptanceReplySourceKey(session) {
  const sessionId = String(session?.id ?? "").trim();
  const turnId = String(session?.turn?.id ?? "").trim();
  if (!sessionId || !turnId) return null;
  return `jace-reply:${sessionId}:${turnId}`;
}

/**
 * Best-effort audit write for a reply that the channel already delivered.
 * This never throws and therefore cannot retroactively make a delivered reply
 * fail. Direct/unbound native channel sessions are explicitly skipped.
 */
export async function recordDeliveredChannelReply({ session, channel, text, env = {}, transport }) {
  const sourceKey = acceptanceReplySourceKey(session);
  if (!sourceKey) return degraded("missing_turn_binding");
  return recordDeliveredAcceptanceReply({
    sessionAuth: session?.auth,
    sourceKey,
    text,
    metadata: { kind: "jace_channel_reply", channel: String(channel ?? "").trim() || "unknown" },
    env,
    transport,
  });
}

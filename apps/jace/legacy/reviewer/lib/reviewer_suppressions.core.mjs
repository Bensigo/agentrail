export const REVIEWER_SUPPRESSIONS_PATH = "/api/v1/runner/reviewer-suppressions";

const DEGRADED_NOTES = {
  config_missing:
    "The console reviewer-suppressions endpoint is not configured; no suppression rules could be fetched.",
  bad_request:
    "The suppression request was malformed; no suppression rules could be fetched.",
  unreachable:
    "The console reviewer-suppressions endpoint could not be reached; no suppression rules could be fetched.",
  unauthorized:
    "The console rejected the suppression request; no suppression rules could be fetched.",
  not_found:
    "The session or repo could not be resolved for suppression lookup; no suppression rules could be fetched.",
  upstream_error:
    "The console errored while loading suppression rules; no suppression rules could be fetched.",
  unexpected_status:
    "The console returned an unexpected status for suppression lookup; no suppression rules could be fetched.",
  bad_body:
    "The console returned an invalid suppression response; no suppression rules could be fetched.",
  route_degraded:
    "The console could not read suppression storage and returned no suppression rules.",
};

export function resolveConsoleConfig(env = {}) {
  const baseUrl = String(env.JACE_CONSOLE_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const token = String(env.JACE_CONSOLE_TOKEN ?? "").trim();
  const missing = [];
  if (!baseUrl) missing.push("JACE_CONSOLE_BASE_URL");
  if (!token) missing.push("JACE_CONSOLE_TOKEN");
  if (missing.length) return { ok: false, missing };
  return { ok: true, baseUrl, token };
}

export function buildReviewerSuppressionsUrl(baseUrl, eveSessionId, repo) {
  const params = new URLSearchParams();
  params.set("eveSessionId", eveSessionId);
  params.set("repo", repo);
  return `${baseUrl}${REVIEWER_SUPPRESSIONS_PATH}?${params.toString()}`;
}

export function classifyStatus(status) {
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 400) return { ok: false, reason: "bad_request" };
  if (status === 401 || status === 403) return { ok: false, reason: "unauthorized" };
  if (status === 404) return { ok: false, reason: "not_found" };
  if (status >= 500) return { ok: false, reason: "upstream_error" };
  return { ok: false, reason: "unexpected_status" };
}

export function noSuppressions(reason, extra = {}) {
  return {
    ok: true,
    degraded: true,
    reason,
    note: DEGRADED_NOTES[reason] ?? DEGRADED_NOTES.unexpected_status,
    rules: [],
    ...extra,
  };
}

function normalizeRule(rule) {
  if (!rule || typeof rule !== "object") return null;
  const findingClass = typeof rule.findingClass === "string"
    ? rule.findingClass.trim().replace(/\s+/g, " ").toLowerCase()
    : "";
  const count = Number(rule.count);
  const reason = typeof rule.reason === "string" ? rule.reason.trim() : "";
  const sourceEventIds = Array.isArray(rule.sourceEventIds)
    ? rule.sourceEventIds.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim())
    : [];
  if (!findingClass || !Number.isFinite(count) || count < 3 || sourceEventIds.length === 0) {
    return null;
  }
  return {
    findingClass,
    count,
    reason: reason || `${count} prior review findings with class "${findingClass}" were dismissed for this repo.`,
    sourceEventIds,
  };
}

export async function reviewerSuppressions({
  env = {},
  eveSessionId,
  repo,
  transport,
}) {
  const sessionId = String(eveSessionId ?? "").trim();
  const repoTrimmed = String(repo ?? "").trim();
  if (!sessionId || !repoTrimmed) return noSuppressions("bad_request");

  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) return noSuppressions("config_missing", { missing: cfg.missing });

  const url = buildReviewerSuppressionsUrl(cfg.baseUrl, sessionId, repoTrimmed);
  let res;
  try {
    res = await transport(url, {
      headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/json" },
    });
  } catch {
    return noSuppressions("unreachable");
  }

  const status = Number(res && res.status);
  const cls = classifyStatus(status);
  if (!cls.ok) return noSuppressions(cls.reason, { status });

  let body;
  try {
    body = await res.json();
  } catch {
    return noSuppressions("bad_body", { status });
  }
  if (!body || typeof body !== "object" || !Array.isArray(body.rules)) {
    return noSuppressions("bad_body", { status });
  }
  if (body.degraded) {
    return noSuppressions("route_degraded", { status });
  }

  return {
    ok: true,
    degraded: false,
    repo: typeof body.repo === "string" ? body.repo : repoTrimmed,
    rules: body.rules.flatMap((rule) => {
      const normalized = normalizeRule(rule);
      return normalized ? [normalized] : [];
    }),
  };
}

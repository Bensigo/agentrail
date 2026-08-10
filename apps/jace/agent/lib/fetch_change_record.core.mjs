// Pure core for the read-only Change Record chat tool. The console resolves
// the tenant from the root Eve session; repo and PR are only lookup keys.

export const CHANGE_RECORD_PR_PATH = "/api/v1/runner/change-record/pr";

const DEGRADED_NOTES = {
  config_missing:
    "The Change Record endpoint is not configured for this Jace deployment; no trust record could be fetched.",
  bad_request:
    "The Change Record request was malformed; no trust record could be fetched.",
  unreachable:
    "The Change Record endpoint could not be reached; no trust record could be fetched. Do not retry from here.",
  unauthorized:
    "The console rejected the Change Record request; the workspace connection may be stale or revoked.",
  not_found:
    "No Change Record was found for this PR in the connected workspace.",
  conflict:
    "The conversation or GitHub connection is not fully set up yet; no Change Record could be fetched.",
  rate_limited: "The console rate limit was hit; no Change Record could be fetched right now.",
  upstream_error: "The console errored while loading the Change Record.",
  unexpected_status: "The console returned an unexpected status while loading the Change Record.",
  bad_body: "The console response was not valid Change Record data.",
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

export function buildChangeRecordUrl(baseUrl, eveSessionId, repo, prNumber) {
  const params = new URLSearchParams();
  params.set("eveSessionId", eveSessionId);
  params.set("repo", repo);
  params.set("prNumber", String(prNumber));
  return `${baseUrl}${CHANGE_RECORD_PR_PATH}?${params.toString()}`;
}

export function classifyStatus(status) {
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 400) return { ok: false, reason: "bad_request" };
  if (status === 401 || status === 403) return { ok: false, reason: "unauthorized" };
  if (status === 404) return { ok: false, reason: "not_found" };
  if (status === 409) return { ok: false, reason: "conflict" };
  if (status === 429) return { ok: false, reason: "rate_limited" };
  if (status >= 500) return { ok: false, reason: "upstream_error" };
  return { ok: false, reason: "unexpected_status" };
}

export function degraded(reason, extra = {}) {
  return {
    ok: false,
    degraded: true,
    reason,
    note: DEGRADED_NOTES[reason] ?? DEGRADED_NOTES.unexpected_status,
    ...extra,
  };
}

function projectRecord(value) {
  if (!value || typeof value !== "object") return null;
  const record = value;
  if (typeof record.id !== "string" || typeof record.workspaceId !== "string") return null;
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    repo: typeof record.repo === "string" ? record.repo : "",
    issueNumber: Number.isInteger(record.issueNumber) ? record.issueNumber : null,
    prNumber: Number.isInteger(record.prNumber) ? record.prNumber : null,
    state: typeof record.state === "string" ? record.state : "",
  };
}

function projectEvidence(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object")
    .slice(0, 6)
    .map((item) => ({
      stage: typeof item.stage === "string" ? item.stage : "",
      label: typeof item.label === "string" ? item.label : "",
      url: typeof item.url === "string" ? item.url : null,
    }))
    .filter((item) => item.stage && item.label);
}

function projectAcceptanceContract(value) {
  if (!value || typeof value !== "object" || !Number.isInteger(value.version) || !Array.isArray(value.criteria)) return null;
  const criteria = value.criteria.map((item) => ({
    id: typeof item?.id === "string" ? item.id.trim() : "",
    text: typeof item?.text === "string" ? item.text.trim() : "",
    userVisible: typeof item?.userVisible === "boolean" ? item.userVisible : null,
  })).filter((item) => item.id && item.text && item.userVisible !== null);
  return criteria.length === value.criteria.length && criteria.length > 0
    ? { version: value.version, criteria }
    : null;
}

/** Fetch a PR Change Record once, returning a usable no-record result. */
export async function fetchChangeRecord({
  env = {},
  eveSessionId,
  repo,
  prNumber,
  transport,
}) {
  const sessionId = String(eveSessionId ?? "").trim();
  const repoName = String(repo ?? "").trim();
  const number = Number(prNumber);
  if (!sessionId || !repoName || !Number.isInteger(number) || number <= 0) {
    return degraded("bad_request");
  }

  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) return degraded("config_missing", { missing: cfg.missing });

  let response;
  try {
    response = await transport(buildChangeRecordUrl(cfg.baseUrl, sessionId, repoName, number), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ eveSessionId: sessionId, repo: repoName, prNumber: number }),
    });
  } catch {
    return degraded("unreachable");
  }

  const status = Number(response && response.status);
  const classification = classifyStatus(status);
  if (!classification.ok) return degraded(classification.reason, { status });

  let body;
  try {
    body = await response.json();
  } catch {
    return degraded("bad_body", { status });
  }
  if (!body || typeof body !== "object") return degraded("bad_body", { status });

  if (body.found !== true) {
    return {
      ok: true,
      found: false,
      repo: repoName,
      prNumber: number,
      note: DEGRADED_NOTES.not_found,
    };
  }

  const record = projectRecord(body.record);
  if (!record) return degraded("bad_body", { status });
  return {
    ok: true,
    found: true,
    repo: repoName,
    prNumber: number,
    record,
    stageEvidence: projectEvidence(body.stageEvidence),
    acceptanceContract: projectAcceptanceContract(body.acceptanceContract),
    contentIsUntrusted: true,
  };
}

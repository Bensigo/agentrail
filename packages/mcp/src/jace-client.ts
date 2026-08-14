export const JACE_MCP_PATH = "/api/v1/agent/jace";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8_000;

export type JaceClientResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: "config_missing" | "unreachable" | "unauthorized" | "server_unavailable" | "invalid_response" };

type Environment = {
  AGENTRAIL_SERVER_BASE_URL?: string;
  AGENTRAIL_MCP_JACE_API_KEY?: string;
};

function config(env: Environment) {
  const key = env.AGENTRAIL_MCP_JACE_API_KEY?.trim();
  const raw = env.AGENTRAIL_SERVER_BASE_URL?.trim();
  if (!key || !raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:"))
    || url.username || url.password || url.search || url.hash) return null;
  return { baseUrl: url.toString().replace(/\/+$/, ""), key };
}

async function callJace(input: {
  method: "GET" | "POST";
  query?: URLSearchParams;
  body?: Record<string, unknown>;
  env?: Environment;
  fetchImpl?: typeof fetch;
}): Promise<JaceClientResult> {
  const resolved = config(input.env ?? process.env);
  if (!resolved) return { ok: false, reason: "config_missing" };
  const suffix = input.query ? `?${input.query.toString()}` : "";
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(`${resolved.baseUrl}${JACE_MCP_PATH}${suffix}`, {
      method: input.method,
      headers: {
        Authorization: `Bearer ${resolved.key}`,
        ...(input.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength && (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_RESPONSE_BYTES)) {
    try { await response.body?.cancel(); } catch { /* closed */ }
    return { ok: false, reason: "invalid_response" };
  }
  if (!response.body) return { ok: false, reason: "invalid_response" };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* closed */ }
        return { ok: false, reason: "invalid_response" };
      }
      chunks.push(next.value);
    }
  } catch {
    return { ok: false, reason: "invalid_response" };
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return { ok: false, reason: "invalid_response" }; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "invalid_response" };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: response.status === 401 || response.status === 403
        ? "unauthorized"
        : response.status >= 500 ? "server_unavailable" : "invalid_response",
    };
  }
  return { ok: true, payload: payload as Record<string, unknown> };
}

export function sendJaceTurn(input: {
  taskContextKey: string;
  messageKey: string;
  message: string;
  env?: Environment;
  fetchImpl?: typeof fetch;
}) {
  return callJace({
    method: "POST",
    body: {
      taskContextKey: input.taskContextKey,
      messageKey: input.messageKey,
      message: input.message,
    },
    env: input.env,
    fetchImpl: input.fetchImpl,
  });
}

export function fetchJaceTask(input: {
  taskContextKey: string;
  messageKey: string;
  env?: Environment;
  fetchImpl?: typeof fetch;
}) {
  return callJace({
    method: "GET",
    query: new URLSearchParams({
      taskContextKey: input.taskContextKey,
      messageKey: input.messageKey,
    }),
    env: input.env,
    fetchImpl: input.fetchImpl,
  });
}

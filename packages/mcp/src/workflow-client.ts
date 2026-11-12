/** One agent-neutral protocol; no coding-agent SDK or Jace dependency. */
export async function workflowRequest(
  path: string,
  body?: unknown,
  verifier = false,
): Promise<Record<string, unknown>> {
  const base = process.env.AGENTRAIL_WORKFLOW_BASE_URL;
  const key = verifier
    ? process.env.AGENTRAIL_WORKFLOW_RELEASE_API_KEY
    : process.env.AGENTRAIL_WORKFLOW_API_KEY;
  if (verifier && !key)
    throw new Error(
      "Run release verification in the operator verifier environment with AGENTRAIL_WORKFLOW_RELEASE_API_KEY",
    );
  if (!base || !key)
    throw new Error(
      "Set AGENTRAIL_WORKFLOW_BASE_URL and AGENTRAIL_WORKFLOW_API_KEY",
    );
  const url = new URL(base);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
  )
    throw new Error("Use an HTTPS Console origin or local loopback HTTP");
  let response: Response;
  try {
    response = await fetch(new URL(`/api/v1/workflow/${path}`, url), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error(
      "AgentRail Console is unreachable; read current state before retrying a write",
    );
  }
  if (!response.ok) {
    if (response.status === 409)
      throw new Error(
        "Workflow conflict; read the task and reconcile the event key/revision",
      );
    throw new Error(`AgentRail Console returned HTTP ${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty Console response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 2 * 1024 * 1024) {
      await reader.cancel();
      throw new Error("Console response exceeded the limit");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

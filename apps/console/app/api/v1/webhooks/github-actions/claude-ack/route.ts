import {
  GithubClaudeAgentAcknowledgementConflictError,
  githubClaudeAcknowledgementAudience,
  recordGithubClaudeAgentAcknowledgement,
} from "@agentrail/db-postgres";
import {
  verifyGithubClaudeAcknowledgementOidcToken,
} from "../../../../../../lib/github-actions-oidc";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 4 * 1024;
const POSITIVE_DECIMAL = /^[1-9][0-9]{0,39}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{8,256}$/;

type AckBody = {
  version: 1;
  activationCommentId: string;
  activationBodySha256: string;
  conclusion: "success";
  sessionId: string;
  runId: string;
  runAttempt: 1;
};

function exactBody(value: unknown): AckBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  const expected = [
    "activationBodySha256",
    "activationCommentId",
    "conclusion",
    "runAttempt",
    "runId",
    "sessionId",
    "version",
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return null;
  }
  if (body.version !== 1 || body.conclusion !== "success" || body.runAttempt !== 1
    || typeof body.activationCommentId !== "string"
    || !POSITIVE_DECIMAL.test(body.activationCommentId)
    || typeof body.runId !== "string" || !POSITIVE_DECIMAL.test(body.runId)
    || typeof body.activationBodySha256 !== "string"
    || !SHA256.test(body.activationBodySha256)
    || typeof body.sessionId !== "string" || !SESSION_ID.test(body.sessionId)) return null;
  return body as AckBody;
}

async function readBoundedJson(request: Request): Promise<unknown | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null
    && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* bounded failure */ }
        return null;
      }
      chunks.push(next.value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * GitHub-authenticated acknowledgement callback for the one selected
 * github_claude route. It records a pinned workflow's successful Action
 * receipt; it does not assert a repair head, deployment, or customer outcome.
 */
export async function POST(request: Request): Promise<Response> {
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/);
  if (!bearer) return json(401, { error: "Unauthorized" });
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
    !== "application/json") return json(400, { error: "Invalid request" });

  const body = exactBody(await readBoundedJson(request));
  if (!body) return json(400, { error: "Invalid request" });
  const audience = githubClaudeAcknowledgementAudience({
    activationCommentId: body.activationCommentId,
    runId: body.runId,
    runAttempt: body.runAttempt,
  });
  if (!audience) return json(400, { error: "Invalid request" });

  const verified = await verifyGithubClaudeAcknowledgementOidcToken({
    token: bearer[1]!,
    audience,
  });
  if (!verified.ok || verified.claims.runId !== body.runId) {
    return json(401, { error: "Unauthorized" });
  }

  try {
    const result = await recordGithubClaudeAgentAcknowledgement({
      activationCommentId: body.activationCommentId,
      activationBodySha256: body.activationBodySha256,
      conclusion: body.conclusion,
      providerSessionId: body.sessionId,
      oidc: verified.claims,
    });
    if (result.kind === "not_admitted") {
      return json(409, { error: "Acknowledgement not admitted" });
    }
    return json(result.kind === "recorded" ? 201 : 200, {
      ok: true,
      status: "acknowledgement_recorded",
      replayed: result.kind === "replayed",
    });
  } catch (error) {
    if (error instanceof GithubClaudeAgentAcknowledgementConflictError) {
      return json(409, { error: "Acknowledgement not admitted" });
    }
    return json(503, { error: "Acknowledgement unavailable" });
  }
}

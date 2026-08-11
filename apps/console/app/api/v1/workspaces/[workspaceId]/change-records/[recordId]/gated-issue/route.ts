import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  AcceptanceGatedGithubIssueConflictError,
  getGithubCorrectionCarrierCredential,
  getWorkspaceMembership,
  readCurrentAcceptanceGatedGithubIssue,
  reportAcceptanceGatedGithubIssuePublication,
  reserveCurrentAcceptanceGatedGithubIssue,
} from "@agentrail/db-postgres";
import { publishGithubGatedIssue } from "../../../../../../../../lib/github-gated-issue";

const MAX_REQUEST_BYTES = 4 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function json(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

async function readBoundedJson(request: Request): Promise<unknown | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null
    && (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_REQUEST_BYTES)) {
    void request.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(next.value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
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

function parseBody(value: unknown): { bindingId: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  return Object.keys(input).length === 1 && typeof input.bindingId === "string"
    && UUID.test(input.bindingId)
    ? { bindingId: input.bindingId }
    : null;
}

function closedResult(
  result: { kind: string; reason?: string },
): NextResponse | null {
  if (result.kind === "not_found") return json(result, 404);
  if (result.kind === "not_authorized") return json(result, 403);
  if (result.kind === "not_current" || result.kind === "not_ready") return json(result, 409);
  return null;
}

function serializeDates(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serializeDates);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, serializeDates(nested)]),
    );
  }
  return value;
}

/**
 * Creates at most one human-gated, unlabeled GitHub issue from DB-issued
 * packet custody. The request accepts no title, body, repo, label, agent, or
 * delivery authority. GitHub intake therefore cannot satisfy its trigger-label
 * gate from this write.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; recordId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id || !UUID.test(session.user.id)) {
    return json({ error: "Unauthorized" }, 401);
  }
  const { workspaceId, recordId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    return json({ error: "Forbidden" }, 403);
  }
  if ([...request.nextUrl.searchParams].length !== 0
    || request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
      !== "application/json") {
    void request.body?.cancel().catch(() => undefined);
    return json({ error: "Invalid gated issue request" }, 400);
  }
  const body = parseBody(await readBoundedJson(request));
  if (!body) return json({ error: "Invalid gated issue request" }, 400);

  let publicationAttempted = false;
  try {
    const current = await readCurrentAcceptanceGatedGithubIssue({ workspaceId, recordId });
    const currentFailure = closedResult(current);
    if (currentFailure) return currentFailure;
    if (current.kind !== "current" || current.binding.bindingId !== body.bindingId) {
      return json({ kind: "not_current" }, 409);
    }

    let credential: Awaited<ReturnType<typeof getGithubCorrectionCarrierCredential>> | null = null;
    if (current.issue === null) {
      credential = await getGithubCorrectionCarrierCredential({
        workspaceId,
        repo: current.binding.repo,
      });
      if (!credential.ok) {
        return credential.kind === "unavailable"
          ? json({ kind: "not_ready", reason: "github_credentials_unavailable" }, 409)
          : json({ error: "Gated issue publication unavailable" }, 503);
      }
    }

    // This transaction is the last local current-binding and same-user
    // membership preflight. Only a newly inserted reservation carries request
    // bytes, so a concurrent call or crash retry cannot perform a second POST.
    const reservation = await reserveCurrentAcceptanceGatedGithubIssue({
      workspaceId,
      recordId,
      bindingId: body.bindingId,
      reservedBy: `user:${session.user.id}`,
    });
    const reservationFailure = closedResult(reservation);
    if (reservationFailure) return reservationFailure;
    if (reservation.kind === "held" || reservation.kind === "terminal") {
      return json(serializeDates(reservation) as Record<string, unknown>);
    }
    if (reservation.kind !== "reserved" || !credential?.ok) {
      return json({ kind: "held", reason: "publication_not_admitted" }, 503);
    }

    publicationAttempted = true;
    const outcome = await publishGithubGatedIssue({
      token: credential.token,
      repo: reservation.binding.repo,
      title: reservation.request.title,
      body: reservation.request.body,
    });
    const reported = await reportAcceptanceGatedGithubIssuePublication({
      workspaceId,
      publicationId: reservation.issue.id,
      outcome,
    });
    if (reported.kind === "not_found") {
      return json({ kind: "held", reason: "publication_outcome_not_persisted" }, 503);
    }
    return json(
      serializeDates(reported) as Record<string, unknown>,
      outcome.kind === "github_201" && reported.kind === "reported" ? 201 : 200,
    );
  } catch (error) {
    if (!publicationAttempted && error instanceof AcceptanceGatedGithubIssueConflictError) {
      return json({ kind: "conflict" }, 409);
    }
    console.error("[acceptance-gated-issue] publication custody unavailable");
    return publicationAttempted
      ? json({ kind: "held", reason: "publication_outcome_not_persisted" }, 503)
      : json({ error: "Gated issue publication unavailable" }, 503);
  }
}

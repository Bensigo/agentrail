import { NextRequest, NextResponse } from "next/server";
import {
  claimAcceptanceDependencyObservationWork,
  getGithubDependencyObservationCredential,
  releaseAcceptanceDependencyObservationClaim,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../lib/jace-console-auth";

const BODY_BYTES = 4 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WORKER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;

function parseBody(value: unknown): { workspaceId: string; workerId: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 2
    || typeof input.workspaceId !== "string" || !UUID.test(input.workspaceId)
    || typeof input.workerId !== "string" || !WORKER.test(input.workerId)) return null;
  return { workspaceId: input.workspaceId.toLowerCase(), workerId: input.workerId };
}

async function boundedJson(request: NextRequest): Promise<unknown | null> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > BODY_BYTES)) return null;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > BODY_BYTES) return null;
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * Claim one server-selected pnpm evidence task, then mint an exact-repository
 * contents-read token. A failed mint releases the opaque lease immediately.
 */
export async function POST(request: NextRequest) {
  const unauthorized = requireJaceConsoleSecret(request);
  if (unauthorized) return unauthorized;

  const body = parseBody(await boundedJson(request));
  if (!body) {
    return NextResponse.json({ error: "Invalid dependency observation claim" }, { status: 400 });
  }

  try {
    const descriptor = await claimAcceptanceDependencyObservationWork(body);
    if (!descriptor) return new NextResponse(null, { status: 204 });
    const { githubInstallationIdentitySha256, ...publicDescriptor } = descriptor;
    const credential = await getGithubDependencyObservationCredential({
      workspaceId: body.workspaceId,
      repo: descriptor.binding.repo,
      expectedInstallationIdentitySha256: githubInstallationIdentitySha256,
    });
    if (!credential.ok) {
      await releaseAcceptanceDependencyObservationClaim({
        workspaceId: body.workspaceId,
        claimId: descriptor.claim.id,
        claimToken: descriptor.claim.token,
      }).catch(() => false);
      return NextResponse.json({ error: "Dependency source credential unavailable" }, { status: 503 });
    }
    return NextResponse.json({
      ...publicDescriptor,
      claim: { ...descriptor.claim, expiresAt: descriptor.claim.expiresAt.toISOString() },
      github: { token: credential.token },
    });
  } catch {
    console.error("Acceptance dependency observation claim unavailable");
    return NextResponse.json({ error: "Dependency observation claim unavailable" }, { status: 503 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  resolveAcceptanceCriterionArtifact,
} from "@agentrail/db-postgres";
import { readBoundedArtifactForProxy } from "../../../../../../../../../../lib/artifacts/proxy";

const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function json(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

/** Resolve an opaque receipt id and proxy bounded bytes without exposing storage coordinates. */
export async function GET(
  request: NextRequest,
  {
    params,
  }: {
    params: Promise<{ workspaceId: string; recordId: string; artifactId: string }>;
  },
) {
  const session = await auth();
  if (!session?.user?.id) return json({ error: "Unauthorized" }, 401);

  const { workspaceId, recordId, artifactId } = await params;
  if (!(await getWorkspaceMembership(session.user.id, workspaceId))) {
    return json({ error: "Forbidden" }, 403);
  }
  if ([...request.nextUrl.searchParams].length !== 0) {
    return json({ error: "Artifact query parameters are not accepted" }, 400);
  }
  if (!UUID_V5.test(artifactId)) return json({ error: "Artifact not found" }, 404);

  try {
    const resolution = await resolveAcceptanceCriterionArtifact({
      workspaceId,
      recordId,
      artifactId,
    });
    if (resolution.kind === "not_found" || resolution.kind === "artifact_not_found") {
      return json({ error: "Artifact not found" }, 404);
    }
    if (resolution.kind === "not_current" || resolution.kind === "not_ready") {
      return json(resolution, 409);
    }

    const proxied = await readBoundedArtifactForProxy({
      artifactKey: resolution.artifact.artifactKey,
      contentSha256: resolution.artifact.contentSha256,
    });
    if (proxied.kind !== "available") {
      return json({ kind: "unavailable", reason: "artifact_bytes_unavailable" }, 503);
    }

    return new NextResponse(Buffer.from(proxied.bytes), {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Length": String(proxied.bytes.byteLength),
        "Content-Type": resolution.artifact.contentType,
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error("[criterion-outcomes] failed to proxy artifact:", error);
    return json({ kind: "unavailable", reason: "artifact_bytes_unavailable" }, 503);
  }
}

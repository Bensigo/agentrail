import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  readAcceptanceContracts,
  readAcceptanceContextPacks,
  recordAcceptanceContextPack,
} from "@agentrail/db-postgres";

const phases = new Set(["plan", "execute", "verify", "review"]);
const sha256 = /^sha256:[a-f0-9]{64}$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string") return value;
  return undefined;
}

function serializePack(pack: NonNullable<Awaited<ReturnType<typeof readAcceptanceContextPacks>>>[number]) {
  return {
    id: pack.id,
    recordId: pack.recordId,
    version: pack.version,
    phase: pack.phase,
    contentHash: pack.contentHash,
    compilerVersion: pack.compilerVersion,
    manifest: pack.manifest,
    custody: pack.custody,
    freshness: pack.freshness,
    jsonArtifactRef: pack.jsonArtifactRef,
    markdownArtifactRef: pack.markdownArtifactRef,
    createdBy: pack.createdBy,
    createdAt: pack.createdAt.toISOString(),
  };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; recordId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { workspaceId, recordId } = await params;
  if (!(await getWorkspaceMembership(session.user.id, workspaceId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const packs = await readAcceptanceContextPacks({ workspaceId, recordId });
    if (packs == null) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ contextPacks: packs.map(serializePack) });
  } catch (error) {
    console.error("[acceptance-context-packs] failed to read packs:", error);
    return NextResponse.json({ error: "Failed to load Acceptance Context Packs" }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; recordId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { workspaceId, recordId } = await params;
  if (!(await getWorkspaceMembership(session.user.id, workspaceId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const phase = body.phase;
  const contentHash = body.contentHash;
  const compilerVersion = body.compilerVersion;
  const manifest = body.manifest;
  const custody = body.custody;
  const freshness = body.freshness;
  const jsonArtifactRef = optionalString(body.jsonArtifactRef);
  const markdownArtifactRef = optionalString(body.markdownArtifactRef);
  if (
    typeof phase !== "string" || !phases.has(phase) ||
    typeof contentHash !== "string" || !sha256.test(contentHash) ||
    typeof compilerVersion !== "string" || !compilerVersion.trim() ||
    !isPlainObject(manifest) || !isPlainObject(custody) || !isPlainObject(freshness) ||
    jsonArtifactRef === undefined || markdownArtifactRef === undefined
  ) {
    return NextResponse.json(
      { error: "phase, sha256 contentHash, compilerVersion, manifest, custody, freshness, and artifact references are invalid" },
      { status: 400 }
    );
  }
  try {
    const contracts = await readAcceptanceContracts({ workspaceId, recordId });
    if (contracts == null) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (!contracts.some((contract) => contract.status === "confirmed")) {
      return NextResponse.json(
        { error: "A confirmed Acceptance Contract is required before building context" },
        { status: 409 }
      );
    }
    const result = await recordAcceptanceContextPack({
      workspaceId,
      recordId,
      phase: phase as "plan" | "execute" | "verify" | "review",
      contentHash,
      compilerVersion: compilerVersion.trim(),
      manifest,
      custody,
      freshness,
      jsonArtifactRef,
      markdownArtifactRef,
      createdBy: `user:${session.user.id}`,
    });
    return NextResponse.json(
      { contextPack: serializePack(result.pack), inserted: result.inserted },
      { status: result.inserted ? 201 : 200 }
    );
  } catch (error) {
    console.error("[acceptance-context-packs] failed to record pack:", error);
    const message = error instanceof Error ? error.message : "Failed to record Acceptance Context Pack";
    const status = message.includes("source content") ? 422 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

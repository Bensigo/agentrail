import { NextRequest, NextResponse } from "next/server";
import {
  readClaimedAcceptanceContextPackCompilation,
  recordAcceptanceContextPack,
  reportAcceptanceContextPackCompilation,
} from "@agentrail/db-postgres";
import { parseAcceptanceContract } from "@agentrail/contracts";
import { requireJaceConsoleSecret } from "../../../../../../../lib/jace-console-auth";
import { validateAcceptanceContextPackMetadata } from "../../../../../../../lib/acceptance-context-pack-validation";

const TERMINAL = new Set(["compiled", "not_proven", "failed"]);
const SHA256 = /^sha256:[a-f0-9]{64}$/i;
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const object = (value: unknown): value is Record<string, unknown> => value != null && typeof value === "object" && !Array.isArray(value);
const optionalString = (value: unknown): string | null | undefined => value === undefined || value === null || typeof value === "string" ? value : undefined;

/**
 * Report one compiler result. The job itself supplies workspace, Record,
 * Contract, and phase; the worker cannot substitute any of those bindings.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ compilationId: string }> }
) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;
  const { compilationId } = await params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const workerId = text(body.workerId) ? body.workerId.trim() : "";
  const status = typeof body.status === "string" ? body.status : "";
  const reason = text(body.reason) ? body.reason.trim() : null;
  if (!text(compilationId) || !workerId || !TERMINAL.has(status) || (body.reason !== undefined && (!text(body.reason) || body.reason.trim().length > 2_000))) {
    return NextResponse.json({ error: "workerId, terminal status, and an optional bounded reason are required" }, { status: 400 });
  }

  if (status !== "compiled") {
    const compilation = await reportAcceptanceContextPackCompilation({
      compilationId,
      workerId,
      status: status as "not_proven" | "failed",
      reason,
    });
    if (!compilation) return NextResponse.json({ error: "compilation not found, not claimed by worker, or already terminal" }, { status: 409 });
    return NextResponse.json({ compilation: { id: compilation.id, status: compilation.status, reason: compilation.reason } });
  }

  const compilerVersion = text(body.compilerVersion) ? body.compilerVersion.trim() : "";
  const contentHash = typeof body.contentHash === "string" ? body.contentHash : "";
  const manifest = body.manifest;
  const custody = body.custody;
  const freshness = body.freshness;
  const jsonArtifactRef = optionalString(body.jsonArtifactRef);
  const markdownArtifactRef = optionalString(body.markdownArtifactRef);
  if (!compilerVersion || !SHA256.test(contentHash) || !object(manifest) || !object(custody) || !object(freshness) || jsonArtifactRef === undefined || markdownArtifactRef === undefined) {
    return NextResponse.json({ error: "compiled requires compilerVersion, sha256 contentHash, bounded metadata, custody, freshness, and valid artifact references" }, { status: 400 });
  }

  const claimed = await readClaimedAcceptanceContextPackCompilation({ compilationId, workerId });
  if (!claimed) return NextResponse.json({ error: "compilation not found, not claimed by worker, or already terminal" }, { status: 409 });
  const contract = parseAcceptanceContract(claimed.contract.contract);
  if (!contract.ok) return NextResponse.json({ error: "claimed Acceptance Contract is invalid" }, { status: 409 });
  const validated = validateAcceptanceContextPackMetadata({ manifest, custody, freshness, contract: contract.value });
  if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: 400 });
  if (!text(claimed.compilation.repositoryRef) || freshness.repositoryRef !== claimed.compilation.repositoryRef) {
    return NextResponse.json({ error: "compiled Context Pack freshness.repositoryRef does not match the claimed compilation repositoryRef" }, { status: 409 });
  }

  try {
    const pack = await recordAcceptanceContextPack({
      workspaceId: claimed.compilation.workspaceId,
      recordId: claimed.compilation.recordId,
      phase: claimed.compilation.phase as "plan" | "execute" | "verify" | "review",
      contentHash,
      compilerVersion,
      manifest,
      custody,
      freshness,
      jsonArtifactRef,
      markdownArtifactRef,
      createdBy: `worker:${workerId}`,
    });
    const compilation = await reportAcceptanceContextPackCompilation({
      compilationId,
      workerId,
      status: "compiled",
      contextPackId: pack.pack.id,
    });
    if (!compilation) return NextResponse.json({ error: "compilation was no longer claimed by worker" }, { status: 409 });
    return NextResponse.json({
      compilation: { id: compilation.id, status: compilation.status, contextPackId: compilation.contextPackId },
      contextPack: { id: pack.pack.id, version: pack.pack.version, inserted: pack.inserted },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to record compiled Context Pack" }, { status: 409 });
  }
}

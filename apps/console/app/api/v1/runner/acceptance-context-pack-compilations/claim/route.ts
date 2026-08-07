import { NextRequest, NextResponse } from "next/server";
import { claimAcceptanceContextPackCompilation, getInstallationToken } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../lib/jace-console-auth";

function repositoryUrl(repository: { name: string; url: string | null }): string {
  if (repository.url && /^https?:\/\//i.test(repository.url)) return repository.url;
  return `https://github.com/${repository.name}`;
}

/**
 * Worker-only claim seam for the Context Pack compiler. The credential is
 * workspace-scoped and ephemeral; source text stays in the disposable worker
 * checkout and must never be returned here or persisted by the Console.
 */
export async function POST(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const workerId = typeof body.workerId === "string" ? body.workerId.trim() : "";
  if (!workerId) return NextResponse.json({ error: "workerId is required" }, { status: 400 });

  const claimed = await claimAcceptanceContextPackCompilation({ workerId });
  if (!claimed) return new NextResponse(null, { status: 204 });
  const githubToken = (await getInstallationToken(claimed.compilation.workspaceId)) ?? "";
  return NextResponse.json({
    compilation: {
      id: claimed.compilation.id,
      workspaceId: claimed.compilation.workspaceId,
      recordId: claimed.compilation.recordId,
      phase: claimed.compilation.phase,
      acceptanceContractId: claimed.compilation.acceptanceContractId,
      acceptanceContractVersion: claimed.compilation.acceptanceContractVersion,
    },
    repository: {
      id: claimed.repository.id,
      name: claimed.repository.name,
      url: repositoryUrl(claimed.repository),
      ref: claimed.repository.ref,
    },
    contract: {
      id: claimed.contract.id,
      version: claimed.contract.version,
      contract: claimed.contract.contract,
    },
    githubToken,
  });
}

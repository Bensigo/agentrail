import { NextRequest, NextResponse } from "next/server";
import {
  getChatIdentityById,
  getJaceSessionByEveSessionId,
  findOrCreateChangeRecord,
  getRepositoryByName,
  readAcceptanceContracts,
  readChangeRecordTimelineByPr,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../lib/jace-console-auth";

const REPO_FORMAT_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const MAX_STAGE_EVIDENCE = 6;

type StageEvidence = {
  stage: string;
  label: string;
  url: string | null;
};

type ConfirmedContract = { version: number; criteria: { id: string; text: string }[] };

function confirmedContract(contracts: Awaited<ReturnType<typeof readAcceptanceContracts>>): ConfirmedContract | null {
  const contract = contracts?.find((item) => item.status === "confirmed");
  const criteria = contract?.contract.acceptanceCriteria;
  if (!contract || !Array.isArray(criteria) || criteria.length === 0) return null;
  const projected = criteria.map((criterion) => {
    const item = criterion && typeof criterion === "object" ? criterion as Record<string, unknown> : null;
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    const text = typeof item?.text === "string" ? item.text.trim() : "";
    return id && text ? { id, text } : null;
  });
  return projected.every(Boolean) ? { version: contract.version, criteria: projected as { id: string; text: string }[] } : null;
}

function parseBody(raw: unknown):
  | { eveSessionId: string; repo: string; prNumber: number; ensure: boolean }
  | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const eveSessionId = typeof o.eveSessionId === "string" ? o.eveSessionId.trim() : "";
  const repo = typeof o.repo === "string" ? o.repo.trim() : "";
  const prNumber = typeof o.prNumber === "number" ? o.prNumber : Number(o.prNumber);
  if (!eveSessionId || !REPO_FORMAT_RE.test(repo)) return null;
  if (!Number.isInteger(prNumber) || prNumber <= 0) return null;
  return { eveSessionId, repo, prNumber, ensure: o.ensure === true };
}

async function resolveWorkspace(
  eveSessionId: string,
  repo: string
): Promise<{ ok: true; workspaceId: string } | { ok: false; response: NextResponse }> {
  const session = await getJaceSessionByEveSessionId(eveSessionId);
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Session not found" }, { status: 404 }),
    };
  }

  const identity = session.chatIdentityId
    ? await getChatIdentityById(session.chatIdentityId)
    : null;
  const workspaceId = session.workspaceId ?? identity?.workspaceId;
  if (!workspaceId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "this conversation has no workspace yet — create one first" },
        { status: 409 }
      ),
    };
  }

  const connectedRepo = await getRepositoryByName(workspaceId, repo);
  if (!connectedRepo) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "repo not connected to this workspace" },
        { status: 404 }
      ),
    };
  }

  return { ok: true, workspaceId };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function labelForPayload(payload: Record<string, unknown>): string | null {
  const kind = stringOrNull(payload.kind);
  if (kind === "review_job") {
    const verdict = stringOrNull(payload.verdict);
    return verdict ? `review posted (${verdict})` : "review posted";
  }
  if (kind === "ac_evidence") return "acceptance evidence";
  if (kind === "qa_ac_results") return "QA evidence";
  if (kind === "issue_snapshot") {
    const issueNumber = typeof payload.issueNumber === "number" ? payload.issueNumber : null;
    return issueNumber == null ? "issue snapshot" : `issue #${issueNumber} snapshot`;
  }
  if (kind === "run") {
    const runId = stringOrNull(payload.runId);
    return runId ? `run ${runId}` : "factory run";
  }
  if (kind === "merge") return "merge event";
  if (kind === "deploy") return "deploy event";
  return null;
}

function urlForPayload(payload: Record<string, unknown>): string | null {
  return (
    stringOrNull(payload.postedReviewUrl) ??
    stringOrNull(payload.url) ??
    stringOrNull(payload.evidenceUrl) ??
    stringOrNull(payload.artifactUrl)
  );
}

export async function POST(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const body = parseBody(raw);
  if (!body) {
    return NextResponse.json(
      {
        error:
          "Body must have eveSessionId (string), repo (owner/name), and prNumber (positive integer)",
      },
      { status: 400 }
    );
  }

  const resolved = await resolveWorkspace(body.eveSessionId, body.repo);
  if (!resolved.ok) return resolved.response;

  try {
    if (body.ensure) {
      await findOrCreateChangeRecord({
        workspaceId: resolved.workspaceId,
        repo: body.repo,
        prNumber: body.prNumber,
        state: "open",
      });
    }
    const timeline = await readChangeRecordTimelineByPr({
      workspaceId: resolved.workspaceId,
      repo: body.repo,
      prNumber: body.prNumber,
    });
    if (!timeline) {
      return NextResponse.json({ found: false }, { status: 200 });
    }
    const acceptanceContract = confirmedContract(await readAcceptanceContracts({
      workspaceId: resolved.workspaceId,
      recordId: timeline.record.id,
    }));

    const stageEvidence: StageEvidence[] = [];
    for (const event of timeline.events) {
      const label = labelForPayload(event.payloadRef);
      if (!label) continue;
      stageEvidence.push({
        stage: event.stage,
        label,
        url: urlForPayload(event.payloadRef),
      });
      if (stageEvidence.length >= MAX_STAGE_EVIDENCE) break;
    }

    return NextResponse.json(
      {
        found: true,
        record: {
          id: timeline.record.id,
          workspaceId: timeline.record.workspaceId,
          repo: timeline.record.repo,
          issueNumber: timeline.record.issueNumber,
          prNumber: timeline.record.prNumber,
          state: timeline.record.state,
        },
        stageEvidence,
        acceptanceContract,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("[runner/change-record/pr] failed to load change record:", err);
    return NextResponse.json(
      { error: "Failed to load change record" },
      { status: 500 }
    );
  }
}

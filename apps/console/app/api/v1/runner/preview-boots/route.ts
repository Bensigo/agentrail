import { NextRequest, NextResponse } from "next/server";
import { enqueuePreviewBoot, getRepositoryByName } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";
import {
  previewBootsDisabled,
  previewBootsDisabledResponse,
  previewBootsWorkspaces,
  resolveWorkspaceId,
} from "./shared";

/**
 * POST /api/v1/runner/preview-boots
 *
 * B2b Task 3 (plan docs/superpowers/plans/2026-08-02-b2b-sandbox-boot.md;
 * spec docs/superpowers/specs/2026-08-02-b2-behavioral-evidence-design.md
 * §B2b §4-5). Jace's request seam for the boot plane: admits one PR-head
 * boot request as a durable, idempotent `preview_boots` row
 * (`enqueuePreviewBoot`, `@agentrail/db-postgres` — see that query's own
 * doc-comment for the deterministic-id dedupe and the advisory-lock-guarded
 * supersede-older-in-flight-head behavior). A dedicated out-of-process
 * worker (a later task) claims rows via `POST .../claim` and reports
 * progress via `POST .../report`; this route only ADMITS.
 *
 * AUTH: `requireJaceConsoleSecret` — the same central `JACE_CONSOLE_TOKEN`
 * guard every Jace-coordinator route uses. Checked FIRST, before the flag or
 * anything else: an unauthenticated caller never learns whether the boot
 * plane is even enabled.
 *
 * FLAG (checked immediately after auth): `PREVIEW_BOOTS_ENABLED !== "1"`
 * 503s with `{error:"preview boots not enabled"}` (`./shared.ts`).
 *
 * SESSION CHAIN: `resolveWorkspaceId` (`./shared.ts`) — a byte-for-byte copy
 * of `review-evidence/route.ts`'s own helper (post-#1569 identity-less
 * semantics). 404 when `eveSessionId` binds no session, 409 when neither
 * the session nor its bound identity carries a workspaceId.
 *
 * ENROLLMENT: `PREVIEW_BOOTS_WORKSPACES` (`./shared.ts`'s
 * `previewBootsWorkspaces()`) — a comma-separated workspaceId allowlist,
 * same idiom as `webhooks/github-app/route.ts`'s `REVIEWER_OF_RECORD_WORKSPACES`.
 * Checked AFTER session resolution (the real workspaceId, never
 * caller-supplied, is what gets checked against the allowlist) and BEFORE
 * the repo-connected gate — an unenrolled workspace never even learns
 * whether it has the requested repo connected.
 *
 * REPO GATE: `getRepositoryByName(workspaceId, repo)` — 404 when the repo is
 * not connected to this workspace, same posture and message as
 * `review-evidence/route.ts`'s own repo gate: never proxies a boot request
 * for an arbitrary/unconnected repo.
 *
 * `ref`: this route always sets it to `headSha`. `preview_boots.ref`
 * (schema's own doc-comment) exists as a separate column FROM `head_sha`
 * because a fork PR's head cannot be fetched with `--branch <sha>` and needs
 * the `refs/pull/<n>/head` form instead — a future caller of this route that
 * knows it is requesting a fork PR's preview could pass that distinction
 * through, but nothing upstream of this route (Jace) currently discriminates
 * fork vs. same-repo PRs, so v1 always uses the plain head SHA.
 *
 * RESPONSE: 200 `{id, deduped}` only — deliberately narrower than
 * `enqueuePreviewBoot`'s own return shape (which also carries `superseded`,
 * an operational detail the requesting caller has no use for and the brief
 * does not ask this route to surface).
 */

interface PreviewBootRequestBody {
  eveSessionId: string;
  repo: string;
  prNumber: number;
  headSha: string;
}

const REQUIRED_FIELDS_MESSAGE = "eveSessionId, repo, prNumber, and headSha are required";

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function parsePreviewBootRequestBody(raw: unknown): PreviewBootRequestBody | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  if (!isNonEmptyString(o.eveSessionId)) return null;
  if (!isNonEmptyString(o.repo)) return null;
  if (typeof o.prNumber !== "number" || !Number.isInteger(o.prNumber) || o.prNumber <= 0) return null;
  if (!isNonEmptyString(o.headSha)) return null;

  return {
    eveSessionId: o.eveSessionId,
    repo: o.repo,
    prNumber: o.prNumber,
    headSha: o.headSha,
  };
}

export async function POST(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;

  if (previewBootsDisabled()) {
    return previewBootsDisabledResponse();
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const body = parsePreviewBootRequestBody(raw);
  if (!body) {
    return NextResponse.json({ error: REQUIRED_FIELDS_MESSAGE }, { status: 400 });
  }

  const resolved = await resolveWorkspaceId(body.eveSessionId);
  if (!resolved.ok) return resolved.response;
  const { workspaceId } = resolved;

  if (!previewBootsWorkspaces().has(workspaceId)) {
    return NextResponse.json({ error: "workspace not enrolled" }, { status: 403 });
  }

  const connectedRepo = await getRepositoryByName(workspaceId, body.repo);
  if (!connectedRepo) {
    return NextResponse.json({ error: "repo not connected to this workspace" }, { status: 404 });
  }

  const result = await enqueuePreviewBoot({
    workspaceId,
    repo: body.repo,
    prNumber: body.prNumber,
    headSha: body.headSha,
    ref: body.headSha,
  });

  return NextResponse.json({ id: result.id, deduped: result.deduped }, { status: 200 });
}

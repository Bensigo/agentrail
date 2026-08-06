import http from "node:http";
import { randomUUID } from "crypto";
import { createRequire } from "node:module";

import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db } from "../db.js";
import { workspaces } from "../schema/workspaces.js";
import { repositories } from "../schema/repositories.js";
import {
  acceptanceContracts,
  changeRecords,
  changeRecordPrRevisions,
  changeRecordPrs,
  evidenceVerificationArtifacts,
  evidenceVerificationExecutions,
  evidenceVerificationPlans,
} from "../schema/change_records.js";
import { previewBoots } from "../schema/preview_boots.js";
import {
  attachExternalPullRequest,
  claimEvidenceVerificationExecution,
  confirmAcceptanceContract,
  createDraftAcceptanceRecord,
  createRepository,
  enqueueEvidenceVerificationExecution,
  recordEvidenceVerificationArtifact,
  recordEvidenceVerificationPlans,
  reportEvidenceVerificationExecution,
} from "../queries/index.js";
import { previewBootId } from "../queries/preview_boots.js";

type SyntheticFixture = {
  workspaceId: string;
  repositoryId: string;
  recordId: string;
  contractId: string;
  contractVersion: number;
  attachmentId: string;
  revisionId: string;
  previewBootId: string;
  planId: string;
  executionId: string;
  prNumber: number;
  headSha: string;
  workerId: string;
};

const DB_AVAILABLE: boolean = await (async () => {
  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
})();
const consoleRequire = createRequire(new URL("../../../../apps/console/package.json", import.meta.url));

const LIVE_RUNTIME_E2E = process.env.JACE_RUNTIME_E2E === "1"
  && typeof process.env.JACE_CONSOLE_BASE_URL === "string"
  && typeof process.env.JACE_CONSOLE_TOKEN === "string"
  && process.env.REVIEW_EVIDENCE_ENABLED === "1"
  && ["S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET"].every((key) => Boolean(process.env[key]));

function syntheticArtifactClient() {
  const endpoint = process.env.S3_ENDPOINT!;
  const accessKeyId = process.env.S3_ACCESS_KEY!;
  const secretAccessKey = process.env.S3_SECRET_KEY!;
  const { S3Client } = consoleRequire("@aws-sdk/client-s3");
  return new S3Client({
    endpoint,
    region: process.env.S3_REGION || "us-east-1",
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "0",
    credentials: { accessKeyId, secretAccessKey },
  });
}

async function readSyntheticArtifact(key: string): Promise<Record<string, unknown>> {
  const bucket = process.env.S3_BUCKET!;
  const { GetObjectCommand } = consoleRequire("@aws-sdk/client-s3");
  const response = await syntheticArtifactClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await response.Body?.transformToString();
  if (!body) throw new Error("expected stored API evidence bytes");
  return JSON.parse(body) as Record<string, unknown>;
}

async function deleteSyntheticArtifact(key: string): Promise<void> {
  const bucket = process.env.S3_BUCKET!;
  const { DeleteObjectCommand } = consoleRequire("@aws-sdk/client-s3");
  await syntheticArtifactClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

async function withLoopbackOrigin<T>(run: (origin: string) => Promise<T>): Promise<T> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected loopback server address");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    return await run(origin);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function seedSyntheticApiExecution(previewUrl: string): Promise<SyntheticFixture> {
  const workspace = await db
    .insert(workspaces)
    .values({
      name: "evidence-verification execution test workspace",
      slug: `test-evidence-verification-${randomUUID()}`,
    })
    .returning({ id: workspaces.id });
  const workspaceId = workspace[0]!.id;
  try {
    const repo = "acme/widgets";
    const repository = await createRepository({
      workspaceId,
      name: repo,
      url: "https://github.com/acme/widgets",
      defaultBranch: "main",
    });
    const draft = await createDraftAcceptanceRecord({
      workspaceId,
      repo,
      workKey: `api-execution-${randomUUID()}`,
      originChannel: "slack",
      sourceReferences: [{ kind: "slack_thread", id: `thread-${randomUUID()}` }],
      contract: {
        originalRequest: "Keep the API health endpoint trustworthy",
        acceptanceCriteria: [
          { id: "api-health", text: "GET /api/health returns 200" },
        ],
        unresolvedQuestions: [],
      },
      createdBy: "user:lead",
    });
    const confirmed = await confirmAcceptanceContract({
      workspaceId,
      recordId: draft.record.id,
      version: draft.contract.version,
      confirmedBy: "user:lead",
    });
    const prNumber = 42;
    const headSha = "a".repeat(40);
    const baseSha = "b".repeat(40);
    const attachment = await attachExternalPullRequest({
      workspaceId,
      recordId: draft.record.id,
      repo,
      repositoryId: repository.id,
      prNumber,
      prUrl: `https://github.com/acme/widgets/pull/${prNumber}`,
      baseSha,
      headSha,
      attachedBy: "user:lead",
    });
    const bootId = previewBootId({ workspaceId, repo, prNumber, headSha });
    await db.insert(previewBoots).values({
      id: bootId,
      workspaceId,
      repo,
      prNumber,
      headSha,
      ref: "refs/pull/42/head",
      status: "ready",
      url: previewUrl,
    });
    const plans = await recordEvidenceVerificationPlans({
      workspaceId,
      recordId: draft.record.id,
      prRevisionId: attachment.revision.id,
      contractId: confirmed.id,
      contractVersion: confirmed.version,
      plannedBy: "user:lead",
      plans: [
        {
          criterionId: "api-health",
          criterionTextSnapshot: "GET /api/health returns 200",
          modality: "api",
          environmentId: bootId,
          flow: "GET /api/health",
          apiRequest: { method: "GET", path: "/api/health", expectedStatus: 200 },
          expectedBehavior: "GET /api/health returns 200",
          status: "planned",
        },
      ],
    });
    const execution = await enqueueEvidenceVerificationExecution({
      workspaceId,
      recordId: draft.record.id,
      prRevisionId: attachment.revision.id,
      verificationPlanId: plans.plans[0]!.id,
    });

    return {
      workspaceId,
      repositoryId: repository.id,
      recordId: draft.record.id,
      contractId: confirmed.id,
      contractVersion: confirmed.version,
      attachmentId: attachment.attachment.id,
      revisionId: attachment.revision.id,
      previewBootId: bootId,
      planId: plans.plans[0]!.id,
      executionId: execution.execution.id,
      prNumber,
      headSha,
      workerId: "worker-a",
    };
  } catch (error) {
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    throw error;
  }
}

async function assertSyntheticFixtureRemoved(fixture: SyntheticFixture): Promise<void> {
  const checks = [
    [changeRecords, fixture.recordId],
    [repositories, fixture.repositoryId],
    [changeRecordPrs, fixture.attachmentId],
    [changeRecordPrRevisions, fixture.revisionId],
    [acceptanceContracts, fixture.contractId],
    [previewBoots, fixture.previewBootId],
    [evidenceVerificationPlans, fixture.planId],
    [evidenceVerificationExecutions, fixture.executionId],
  ] as const;

  for (const [table, id] of checks) {
    const rows = await db.select({ id: table.id }).from(table).where(eq(table.id, id));
    expect(rows).toHaveLength(0);
  }

  const artifactRows = await db
    .select({ id: evidenceVerificationArtifacts.id })
    .from(evidenceVerificationArtifacts)
    .where(eq(evidenceVerificationArtifacts.verificationPlanId, fixture.planId));
  expect(artifactRows).toHaveLength(0);
}

describe.skipIf(!DB_AVAILABLE)(
  "evidence verification execution integration — live Postgres claim/report",
  () => {
    let fixture: SyntheticFixture | null = null;
    let liveArtifactKey: string | null = null;

    beforeEach(() => {
      fixture = null;
      liveArtifactKey = null;
    });

    afterEach(async () => {
      if (liveArtifactKey) await deleteSyntheticArtifact(liveArtifactKey);
      if (!fixture) return;
      await db.delete(workspaces).where(eq(workspaces.id, fixture.workspaceId));
      await assertSyntheticFixtureRemoved(fixture);
      fixture = null;
    });

    it("claims only the exact queued safe API plan, then records a proven completion bound to the same execution, worker, and revision", async () => {
      await withLoopbackOrigin(async (origin) => {
        fixture = await seedSyntheticApiExecution(`${origin}/api/health`);

        const claimed = await claimEvidenceVerificationExecution({
          workerId: fixture.workerId,
        });

        expect(claimed).not.toBeNull();
        expect(claimed?.workspaceId).toBe(fixture.workspaceId);
        expect(claimed?.execution.id).toBe(fixture.executionId);
        expect(claimed?.execution.workerId).toBe(fixture.workerId);
        expect(claimed?.plan.id).toBe(fixture.planId);
        expect(claimed?.plan.modality).toBe("api");
        expect(claimed?.plan.apiRequest).toEqual({
          method: "GET",
          path: "/api/health",
          expectedStatus: 200,
        });
        expect(claimed?.repositoryFullName).toBe("acme/widgets");
        expect(claimed?.prNumber).toBe(fixture.prNumber);
        expect(claimed?.headSha).toBe(fixture.headSha);
        expect(claimed?.previewUrl).toBe(`${origin}/api/health`);

        const artifact = await recordEvidenceVerificationArtifact({
          verificationPlanId: fixture.planId,
          artifactKey: `loopback/api-health-${randomUUID()}.json`,
          contentType: "application/json",
          contentSha256: "a".repeat(64),
          collectedBy: `verification-executor:${fixture.executionId}`,
        });

        const wrongWorker = await reportEvidenceVerificationExecution({
          executionId: fixture.executionId,
          workerId: "worker-b",
          status: "failed",
          resultReason: "wrong worker",
        });
        expect(wrongWorker).toBeNull();

        const reported = await reportEvidenceVerificationExecution({
          executionId: fixture.executionId,
          workerId: fixture.workerId,
          status: "proven",
          observedBehavior: "GET /api/health => 200",
          artifactIds: [artifact.id],
        });

        expect(reported).not.toBeNull();
        expect(reported?.id).toBe(fixture.executionId);
        expect(reported?.status).toBe("proven");
        expect(reported?.workerId).toBe(fixture.workerId);
        expect(reported?.artifactIds).toEqual([artifact.id]);

        const stored = await db
          .select()
          .from(evidenceVerificationExecutions)
          .where(eq(evidenceVerificationExecutions.id, fixture.executionId))
          .limit(1);

        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({
          id: fixture.executionId,
          verificationPlanId: fixture.planId,
          status: "proven",
          workerId: fixture.workerId,
          observedBehavior: "GET /api/health => 200",
          artifactIds: [artifact.id],
        });
      });
    });

    it("fails closed when the ready-preview precondition is missing, so an unready plan is not claimed", async () => {
      await withLoopbackOrigin(async (origin) => {
        fixture = await seedSyntheticApiExecution(`${origin}/api/health`);

        await db
          .update(previewBoots)
          .set({ status: "pending", url: null })
          .where(eq(previewBoots.id, fixture.previewBootId));

        const claimed = await claimEvidenceVerificationExecution({
          workerId: fixture.workerId,
        });
        expect(claimed).toBeNull();
      });
    });

    it.skipIf(!LIVE_RUNTIME_E2E)("runs one exact-head API criterion through the real Console, Jace worker, artifact store, and completion route", async () => {
      await withLoopbackOrigin(async (origin) => {
        fixture = await seedSyntheticApiExecution(`${origin}/api/health`);
        const env = {
          JACE_CONSOLE_BASE_URL: process.env.JACE_CONSOLE_BASE_URL!,
          JACE_CONSOLE_TOKEN: process.env.JACE_CONSOLE_TOKEN!,
        };
        const [{ createVerificationExecutionConsole }, { createVerificationExecutionWorker }, { createVerificationApiExecuteFn }] = await Promise.all([
          import("../../../../apps/jace/agent/lib/verification_execution_console.mjs"),
          import("../../../../apps/jace/agent/lib/verification_execution_worker.core.mjs"),
          import("../../../../apps/jace/agent/lib/verification_api_executor.mjs"),
        ]);
        const workerId = `live-runtime-${randomUUID()}`;
        const executionConsole = createVerificationExecutionConsole({ env });
        const apiExecute = createVerificationApiExecuteFn({ env });
        const worker = createVerificationExecutionWorker({
          claim: () => executionConsole.claim(workerId),
          execute: apiExecute,
          complete: (input: unknown) => executionConsole.complete(input),
        });

        expect(await worker.tick()).toBe("proven");

        const stored = await db
          .select()
          .from(evidenceVerificationExecutions)
          .where(eq(evidenceVerificationExecutions.id, fixture.executionId))
          .limit(1);
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({
          id: fixture.executionId,
          verificationPlanId: fixture.planId,
          status: "proven",
          workerId,
        });
        expect(stored[0]?.artifactIds).toHaveLength(1);

        const artifacts = await db
          .select()
          .from(evidenceVerificationArtifacts)
          .where(eq(evidenceVerificationArtifacts.verificationPlanId, fixture.planId));
        expect(artifacts).toHaveLength(1);
        expect(artifacts[0]).toMatchObject({
          verificationPlanId: fixture.planId,
          contentType: "application/json",
        });
        liveArtifactKey = artifacts[0]!.artifactKey;
        expect(await readSyntheticArtifact(liveArtifactKey)).toMatchObject({
          request: { method: "GET", url: `${origin}/api/health` },
          response: { status: 200 },
          assertions: ["criterion api-health: expected status 200; observed status 200"],
        });
      });
    });
  }
);

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

const BASE_URL = "http://127.0.0.1:3100";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURE_SCRIPT = "scripts/proof-r112-console-record.ts";
const CRITERION_TEXT = "A saved filter remains visible after reload";
const SECOND_CRITERION_TEXT = "The saved-filter summary remains after the retained entry";

type BrowserProofState = {
  workspaceId: string;
  recordId: string;
  ownerUserId: string;
  memberUserId: string;
  foreignUserId: string;
  ownerSessionToken: string;
  memberSessionToken: string;
  foreignSessionToken: string;
  repo: string;
  prNumber: number;
  headA: string;
  headB: string;
  originalHeadCycleId: string;
  currentHeadCycleId: string;
  artifactId: string;
  artifactKey: string;
  artifactSha256: string;
  artifactBytesBase64: string;
  evidenceRef: string;
  executionId: string;
  previewBootId: string;
  observedFailure: string;
};

type FixtureInspection = {
  requests: number;
  publications: number;
  approvals: number;
  currentHeadSha: string | null;
  currentHeadCycleId: string | null;
  correctionPackets: string;
  correctionPacketReason: string | null;
  criterionOutcomes: string;
  criterionOutcomeReason: string | null;
  gatedIssue: string;
  gatedIssueReason: string | null;
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the R11.2 browser proof`);
  return value;
}

function artifactClient(): { client: S3Client; bucket: string } {
  const client = new S3Client({
    endpoint: requiredEnv("S3_ENDPOINT"),
    region: process.env["S3_REGION"] || "us-east-1",
    forcePathStyle: process.env["S3_FORCE_PATH_STYLE"] !== "0",
    credentials: {
      accessKeyId: requiredEnv("S3_ACCESS_KEY"),
      secretAccessKey: requiredEnv("S3_SECRET_KEY"),
    },
  });
  return { client, bucket: requiredEnv("S3_BUCKET") };
}

async function runFixture<T>(command: string, input?: unknown): Promise<T> {
  const child = spawn(
    "pnpm",
    [
      "--filter",
      "@agentrail/db-postgres",
      "exec",
      "node",
      "--import",
      "tsx",
      FIXTURE_SCRIPT,
      command,
    ],
    {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (input !== undefined) child.stdin.end(JSON.stringify(input));
  else child.stdin.end();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exitCode = await new Promise<number | null>((done) => child.once("close", done));
  if (exitCode !== 0) {
    throw new Error(`fixture ${command} failed (${exitCode}): ${Buffer.concat(stderr).toString("utf8")}`);
  }
  return JSON.parse(Buffer.concat(stdout).toString("utf8")) as T;
}

async function authenticatedContext(browser: Browser, sessionToken: string): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.addCookies([{
    name: "authjs.session-token",
    value: sessionToken,
    url: BASE_URL,
    httpOnly: true,
    sameSite: "Lax",
    secure: false,
  }]);
  return context;
}

function detailPath(state: BrowserProofState): string {
  return `/api/v1/workspaces/${state.workspaceId}/change-records/${state.recordId}`;
}

function artifactPath(state: BrowserProofState): string {
  return `${detailPath(state)}/criterion-outcomes/artifacts/${state.artifactId}`;
}

function gatedIssuePath(state: BrowserProofState): string {
  return `${detailPath(state)}/gated-issue`;
}

function expectNoPrivateStorageCoordinates(
  body: string,
  state: BrowserProofState,
): void {
  for (const coordinate of [
    state.artifactKey,
    "review-evidence/",
    requiredEnv("S3_ENDPOINT"),
    requiredEnv("S3_BUCKET"),
    requiredEnv("S3_SECRET_KEY"),
    "X-Amz-",
  ]) expect(body).not.toContain(coordinate);
  for (const privateField of [
    '"artifactKey"',
    '"evidenceKey"',
    '"evidenceKeys"',
    '"bootLogKey"',
  ]) expect(body).not.toContain(privateField);
}

function captureBrowserDataTraffic(page: Page): {
  assertNoPrivateStorageCoordinates(state: BrowserProofState): Promise<void>;
} {
  const metadata: string[] = [];
  const bodies: Array<Promise<string>> = [];
  const browserDataResource = (resourceType: string) => (
    resourceType === "document" || resourceType === "fetch" || resourceType === "xhr"
  );
  page.on("request", (request) => {
    if (!browserDataResource(request.resourceType())) return;
    metadata.push(
      request.url(),
      JSON.stringify(request.headers()),
      request.postData() ?? "",
    );
  });
  page.on("response", (response) => {
    if (!browserDataResource(response.request().resourceType())) return;
    metadata.push(response.url(), JSON.stringify(response.headers()));
    const contentType = response.headers()["content-type"] ?? "";
    if (/json|text|x-component/iu.test(contentType)) {
      bodies.push(response.text().catch(() => ""));
    }
  });
  return {
    async assertNoPrivateStorageCoordinates(state) {
      const traffic = [...metadata, ...(await Promise.all(bodies))].join("\n");
      expectNoPrivateStorageCoordinates(traffic, state);
    },
  };
}

test.describe.serial("R11.2 authenticated Acceptance Record detail", () => {
  let state: BrowserProofState;
  let s3: S3Client;
  let bucket: string;

  test.beforeAll(async () => {
    state = await runFixture<BrowserProofState>("seed");
    ({ client: s3, bucket } = artifactClient());
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: state.artifactKey,
      Body: Buffer.from(state.artifactBytesBase64, "base64"),
      ContentType: "image/png",
    }));
  });

  test.afterAll(async () => {
    try {
      if (s3 && bucket && state?.artifactKey) {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: state.artifactKey }));
      }
    } finally {
      s3?.destroy();
      if (state) await runFixture("cleanup", state);
    }
  });

  test("an authenticated owner sees exact current evidence without browser issue authority", async ({ browser }) => {
    const context = await authenticatedContext(browser, state.ownerSessionToken);
    const detailResponse = await context.request.get(detailPath(state));
    expect(detailResponse.status()).toBe(200);
    const detailText = await detailResponse.text();
    expectNoPrivateStorageCoordinates(detailText, state);
    const detail = JSON.parse(detailText) as {
      record: { repo: string; currentPrHeadSha: string; currentPrHeadCycleId: string };
      acceptanceDetail: {
        kind: string;
        detail: { contract: { contract: { acceptanceCriteria: Array<{ id: string; text: string }> } } };
      };
      correctionPackets: { kind: string; packets: Array<{
        criterion: { id: string; snapshot: string };
        expected: string;
        observed: string;
        requiredCorrection: string;
        scopeBoundary: string;
        reverification: string;
      }> };
      criterionOutcomes: { kind: string; bundle: { outcomes: Array<{ criterionId: string; state: string }> } };
      reviewMetrics: {
        kind: string;
        summary: {
          reviewEffort: { eligible: number; known: number; unknown: number; totalMinutes: number | null };
          decisions: { eligible: number; known: number; unknown: number };
        };
      };
      canRecordFinalDecision: boolean;
      canRecordReviewEffort: boolean;
      canCreateGatedGithubIssue: boolean;
    };
    expect(detail.record).toMatchObject({
      repo: state.repo,
      currentPrHeadSha: state.headA,
      currentPrHeadCycleId: state.currentHeadCycleId,
    });
    expect(detail.acceptanceDetail.kind).toBe("record");
    expect(detail.acceptanceDetail.detail.contract.contract.acceptanceCriteria.map(
      (criterion) => [criterion.id, criterion.text],
    )).toEqual([
      ["AC-1", CRITERION_TEXT],
      ["AC-2", SECOND_CRITERION_TEXT],
    ]);
    expect(detail.criterionOutcomes.kind).toBe("current");
    expect(detail.criterionOutcomes.bundle.outcomes.map(
      (outcome) => [outcome.criterionId, outcome.state],
    )).toEqual([
      ["AC-1", "failed"],
      ["AC-2", "not_testable"],
    ]);
    expect(detail.correctionPackets.kind).toBe("current");
    expect(detail.correctionPackets.packets).toHaveLength(1);
    expect(detail.correctionPackets.packets[0]).toMatchObject({
      criterion: { id: "AC-1", snapshot: CRITERION_TEXT },
      expected: CRITERION_TEXT,
      observed: state.observedFailure,
      requiredCorrection: "Keep the saved filter visible after reload and retain new exact-head evidence.",
      scopeBoundary: `Only AC-1 for ${state.repo}#${state.prNumber} at ${state.headA}.`,
      reverification: "Rerun the persisted verification plan against the next exact head.",
    });
    expect(detail.reviewMetrics).toMatchObject({
      kind: "record",
      summary: {
        reviewEffort: { eligible: 1, known: 0, unknown: 1, totalMinutes: null },
        decisions: { eligible: 1, known: 0, unknown: 1 },
      },
    });
    expect(detail.canRecordFinalDecision).toBe(true);
    expect(detail.canRecordReviewEffort).toBe(true);
    expect(detail.canCreateGatedGithubIssue).toBe(false);

    const page = await context.newPage();
    const traffic = captureBrowserDataTraffic(page);
    const navigation = await page.goto(`/dashboard/${state.workspaceId}/changes/${state.recordId}`);
    expect(navigation?.ok()).toBe(true);

    await expect(page.getByText(state.repo, { exact: true }).first()).toBeVisible();
    await expect(page.locator(`code[title="${state.headA}"]`)).toBeVisible();
    await expect(page.getByText("Confirmed Acceptance Contract")).toBeVisible();
    await expect(page.getByText(CRITERION_TEXT).first()).toBeVisible();
    await expect(page.getByText(SECOND_CRITERION_TEXT).first()).toBeVisible();
    await expect(page.getByText("Current recorded outcome: Failed")).toBeVisible();
    await expect(page.getByText("Current recorded outcome: Not testable")).toBeVisible();
    const renderedContractOrder = await page.getByRole("heading", {
      name: "Acceptance criteria",
      exact: true,
    }).evaluate((heading) => Array.from(heading.nextElementSibling?.children ?? []).map((item) => {
      const paragraphs = Array.from(item.children).filter((child) => child.tagName === "P");
      return paragraphs.slice(0, 2).map((paragraph) => paragraph.textContent?.trim() ?? "");
    }));
    expect(renderedContractOrder).toEqual([
      ["AC-1", CRITERION_TEXT],
      ["AC-2", SECOND_CRITERION_TEXT],
    ]);
    const renderedOutcomeOrder = await page.locator("p").filter({
      hasText: /^Current recorded outcome:/u,
    }).evaluateAll((outcomeNodes) => outcomeNodes.map((outcomeNode) => {
      const criterionCard = outcomeNode.parentElement?.parentElement;
      const paragraphs = criterionCard
        ? Array.from(criterionCard.children).filter((child) => child.tagName === "P")
        : [];
      return {
        criterionId: paragraphs[0]?.textContent?.trim() ?? "",
        criterionText: paragraphs[1]?.textContent?.trim() ?? "",
        outcome: outcomeNode.textContent?.trim() ?? "",
      };
    }));
    expect(renderedOutcomeOrder).toEqual([
      {
        criterionId: "AC-1",
        criterionText: CRITERION_TEXT,
        outcome: "Current recorded outcome: Failed",
      },
      {
        criterionId: "AC-2",
        criterionText: SECOND_CRITERION_TEXT,
        outcome: "Current recorded outcome: Not testable",
      },
    ]);
    await expect(page.getByText(state.observedFailure).first()).toBeVisible();
    await expect(
      page.getByText("Required correction", { exact: true }).locator("..").locator("dd"),
    ).toHaveText("Keep the saved filter visible after reload and retain new exact-head evidence.");
    await expect(page.getByText(`Only AC-1 for ${state.repo}#${state.prNumber} at ${state.headA}.`)).toBeVisible();
    await expect(page.getByText("Rerun the persisted verification plan against the next exact head.")).toBeVisible();
    await expect(page.getByText("Current artifact receipts: 1")).toBeVisible();
    await expect(page.getByText(/Ask Jace to create the current correction issue/)).toBeVisible();
    await expect(page.getByRole("button", { name: /create.*issue/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Request changes" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reject PR" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Explicit exception rationale" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Record approval with exception" })).toBeDisabled();
    await expect(page.getByRole("spinbutton", { name: "Current cycle review effort (whole minutes)" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Record review effort" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Approve PR" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Approve & mint external-builder Pack" })).toHaveCount(0);
    expectNoPrivateStorageCoordinates(await page.content(), state);
    await traffic.assertNoPrivateStorageCoordinates(state);
    await context.close();
  });

  test("a member can read the opaque artifact but receives no private coordinates or controls", async ({ browser }) => {
    const context = await authenticatedContext(browser, state.memberSessionToken);
    const response = await context.request.get(detailPath(state));
    expect(response.status()).toBe(200);
    const body = await response.text();
    expectNoPrivateStorageCoordinates(body, state);

    const artifact = await context.request.get(artifactPath(state));
    expect(artifact.status()).toBe(200);
    expect(Buffer.from(await artifact.body())).toEqual(Buffer.from(state.artifactBytesBase64, "base64"));
    expect(artifact.url()).not.toContain(state.artifactKey);
    expect(artifact.url()).not.toContain("X-Amz-");

    const page = await context.newPage();
    const traffic = captureBrowserDataTraffic(page);
    const navigation = await page.goto(`/dashboard/${state.workspaceId}/changes/${state.recordId}`);
    expect(navigation?.ok()).toBe(true);
    await expect(page.getByText("Current recorded outcome: Failed")).toBeVisible();
    await expect(page.getByText("A workspace owner or admin can record the final decision.")).toBeVisible();
    for (const name of [
      "Approve PR",
      "Request changes",
      "Reject PR",
      "Record approval with exception",
      "Record review effort",
      "Approve & mint external-builder Pack",
    ]) {
      await expect(page.getByRole("button", { name })).toHaveCount(0);
    }
    await expect(page.getByRole("textbox", { name: "Explicit exception rationale" })).toHaveCount(0);
    await expect(page.getByRole("spinbutton", { name: "Current cycle review effort (whole minutes)" })).toHaveCount(0);
    expectNoPrivateStorageCoordinates(await page.content(), state);
    await traffic.assertNoPrivateStorageCoordinates(state);
    await context.close();
  });

  test("opaque artifact access returns only hash-bound bytes and hardened headers", async ({ browser }) => {
    const owner = await authenticatedContext(browser, state.ownerSessionToken);
    const response = await owner.request.get(artifactPath(state));
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/png");
    expect(response.headers()["cache-control"]).toBe("private, no-store");
    expect(response.headers()["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.from(await response.body())).toEqual(Buffer.from(state.artifactBytesBase64, "base64"));
    expect(response.url()).not.toContain(state.artifactKey);
    expect(response.url()).not.toContain("X-Amz-");

    const withQuery = await owner.request.get(`${artifactPath(state)}?download=1`);
    expect(withQuery.status()).toBe(400);
    const wrongId = await owner.request.get(`${detailPath(state)}/criterion-outcomes/artifacts/00000000-0000-5000-8000-000000000000`);
    expect(wrongId.status()).toBe(404);
    await owner.close();
  });

  test("authentication and tenant boundaries fail closed", async ({ browser, request }) => {
    expect((await request.get(detailPath(state))).status()).toBe(401);
    expect((await request.get(artifactPath(state))).status()).toBe(401);

    const foreign = await authenticatedContext(browser, state.foreignSessionToken);
    expect((await foreign.request.get(detailPath(state))).status()).toBe(403);
    expect((await foreign.request.get(artifactPath(state))).status()).toBe(403);
    await foreign.close();
  });

  test("owner and member browser publication attempts retain Jace-only authority", async ({ browser }) => {
    const owner = await authenticatedContext(browser, state.ownerSessionToken);
    const ownerResponse = await owner.request.post(gatedIssuePath(state), { data: {} });
    expect(ownerResponse.status()).toBe(409);
    expect(await ownerResponse.json()).toEqual({
      kind: "jace_approval_required",
      recordId: state.recordId,
      message: "Ask Jace to create the current correction issue for this Acceptance Record.",
    });
    await owner.close();

    const member = await authenticatedContext(browser, state.memberSessionToken);
    expect((await member.request.post(gatedIssuePath(state), { data: {} })).status()).toBe(403);
    await member.close();

    const inspection = await runFixture<FixtureInspection>("inspect", state);
    expect(inspection.requests).toBe(0);
    expect(inspection.publications).toBe(0);
    expect(inspection.approvals).toBe(0);
  });

  test("a hash mismatch returns no partial artifact bytes", async ({ browser }) => {
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: state.artifactKey,
      Body: Buffer.from("tampered artifact bytes", "utf8"),
      ContentType: "image/png",
    }));
    try {
      const owner = await authenticatedContext(browser, state.ownerSessionToken);
      const response = await owner.request.get(artifactPath(state));
      expect(response.status()).toBe(503);
      expect(await response.json()).toEqual({
        kind: "unavailable",
        reason: "artifact_bytes_unavailable",
      });
      await owner.close();
    } finally {
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: state.artifactKey,
        Body: Buffer.from(state.artifactBytesBase64, "base64"),
        ContentType: "image/png",
      }));
    }
  });

  test("A-B-A preserves historical custody without reviving A1 as current", async ({ browser }) => {
    const original = state;
    state = await runFixture<BrowserProofState>("advance", state);
    expect(state.currentHeadCycleId).not.toBe(state.originalHeadCycleId);

    const owner = await authenticatedContext(browser, state.ownerSessionToken);
    const response = await owner.request.get(detailPath(state));
    expect(response.status()).toBe(200);
    const body = await response.json() as {
      record: { currentPrHeadSha: string; currentPrHeadCycleId: string };
      correctionPackets: { kind: string; reason?: string };
      criterionOutcomes: { kind: string };
    };
    expect(body.record.currentPrHeadSha).toBe(state.headA);
    expect(body.record.currentPrHeadCycleId).toBe(state.currentHeadCycleId);
    expect(body.correctionPackets).toEqual({
      kind: "not_ready",
      reason: "no_correction_packets",
    });
    expect(body.criterionOutcomes.kind).not.toBe("current");

    const oldArtifact = await owner.request.get(artifactPath(original));
    expect(oldArtifact.status()).toBe(409);
    const page = await owner.newPage();
    await page.goto(`/dashboard/${state.workspaceId}/changes/${state.recordId}`);
    await expect(page.getByText("Current criterion outcomes are not available.")).toBeVisible();
    await expect(page.getByText("Current artifact receipts: Unknown")).toBeVisible();
    await expect(page.getByText("Current recorded outcome: Failed")).toHaveCount(0);
    await expect(page.getByText(state.observedFailure)).toHaveCount(0);
    await expect(page.getByText("Keep the saved filter visible after reload and retain new exact-head evidence.")).toHaveCount(0);
    await owner.close();

    const inspection = await runFixture<FixtureInspection>("inspect", state);
    expect(inspection.currentHeadSha).toBe(state.headA);
    expect(inspection.currentHeadCycleId).toBe(state.currentHeadCycleId);
    expect(inspection.correctionPackets).toBe("not_ready");
    expect(inspection.correctionPacketReason).toBe("no_correction_packets");
    expect(inspection.criterionOutcomes).toBe("not_ready");
    expect(inspection.criterionOutcomeReason).toBe("review_job_unavailable");
    expect(inspection.gatedIssue).toBe("not_ready");
    expect(inspection.gatedIssueReason).toBe("review_job_unavailable");
    expect(inspection.requests).toBe(0);
    expect(inspection.publications).toBe(0);
    expect(inspection.approvals).toBe(0);
  });
});

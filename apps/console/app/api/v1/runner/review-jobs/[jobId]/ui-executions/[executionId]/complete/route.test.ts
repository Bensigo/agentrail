import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({ appendChangeRecordEvent: vi.fn(), getJaceSessionByEveSessionId: vi.fn(), getPreviewBoot: vi.fn() }));
vi.mock("../../../../../../../../../lib/review-job-proof-attestation", () => ({ resolveCurrentReviewJobPlan: vi.fn() }));
vi.mock("../../../../../../../../../lib/artifacts/store", () => ({ artifactKey: vi.fn(() => "review-evidence/exact.png"), putArtifact: vi.fn(), signedGetUrl: vi.fn(), storageConfigured: vi.fn() }));

import { appendChangeRecordEvent, getJaceSessionByEveSessionId, getPreviewBoot } from "@agentrail/db-postgres";
import { artifactKey, putArtifact, signedGetUrl, storageConfigured } from "../../../../../../../../../lib/artifacts/store";
import { type ExactReviewJobProof, resolveCurrentReviewJobPlan } from "../../../../../../../../../lib/review-job-proof-attestation";
import { buildReviewJobUiAttempt, buildReviewJobUiResult, buildReviewJobUiScreenshotReservation, reviewJobUiAttemptEventKey, reviewJobUiResultEventKey, reviewJobUiScreenshotReservationEventKey } from "../../../../../../../../../lib/review-job-ui-execution";
import { POST } from "./route";

const SECRET = "jace-shared-secret-abc123";
const HEAD_SHA = "a".repeat(40);
const ORIGINAL_ENV = { JACE_CONSOLE_TOKEN: process.env.JACE_CONSOLE_TOKEN, REVIEW_EVIDENCE_ENABLED: process.env.REVIEW_EVIDENCE_ENABLED };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";
const JPEG = "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJUAB//Z";
const TRUNCATED_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString("base64");
const TRUNCATED_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9]).toString("base64");

function proof(
  events: Array<{ eventKey: string; payloadRef: Record<string, unknown> }> = [],
  criterionId = "AC-UI"
): ExactReviewJobProof {
  return {
    job: { id: "job-1", workspaceId: "ws-1", repo: "acme/widgets", prNumber: 42, headSha: HEAD_SHA, state: "running" },
    timeline: { record: { id: "record-1" }, events }, contract: { id: "contract-1", version: 3 },
    verificationPlan: { plans: [{ criterionId, criterionTextSnapshot: "The filter is visible.", modality: "ui", environmentKind: "isolated_preview", flow: "Open and inspect.", status: "planned", notTestableReason: null, uiSteps: [{ action: "open", path: "/filters" }, { action: "expect_text", text: "Saved" }, { action: "screenshot", label: "filter" }] }] },
  } as unknown as ExactReviewJobProof;
}
function preview(overrides = {}) { return { id: "boot-1", workspaceId: "ws-1", repo: "acme/widgets", prNumber: 42, headSha: HEAD_SHA, status: "ready", url: "https://preview.example.test/filters", expiresAt: new Date(Date.now() + 60_000), ...overrides }; }
function timelineEvent(eventKey: string, payloadRef: Record<string, unknown>): ExactReviewJobProof["timeline"]["events"][number] {
  return { id: `event-${eventKey}`, recordId: "record-1", eventKey, stage: "verification", actor: "jace:review-ui-executor", payloadRef, at: new Date(), createdAt: new Date() };
}
function boundProof() { const current = proof(); const plan = current.verificationPlan.plans[0]; const attempt = buildReviewJobUiAttempt({ proof: current, plan, boot: preview() })!; current.timeline.events = [timelineEvent(reviewJobUiAttemptEventKey({ proof: current, plan }), attempt)]; return { current, plan, attempt }; }
function session(overrides = {}) { return { eveSessionId: "eve-1", workspaceId: "ws-1", channel: "review-job", conversationKey: "review-job:job-1", status: "active", ...overrides }; }
function request(body: unknown, executionId = boundProof().attempt.executionId, auth = true) { return new NextRequest(`http://localhost/api/v1/runner/review-jobs/job-1/ui-executions/${executionId}/complete`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { Authorization: `Bearer ${SECRET}` } : {}) }, body: JSON.stringify(body) }); }
function params(executionId: string) { return { params: Promise.resolve({ jobId: "job-1", executionId }) }; }
function body(overrides = {}) { return { eveSessionId: "eve-1", assertionPassed: true, observedUrl: "https://preview.example.test/filters?after=1", imageBase64: PNG, contentType: "image/png", ...overrides }; }

beforeEach(() => {
  vi.clearAllMocks(); process.env.JACE_CONSOLE_TOKEN = SECRET; process.env.REVIEW_EVIDENCE_ENABLED = "1";
  vi.mocked(storageConfigured).mockReturnValue(true); vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(session() as never);
  const bound = boundProof(); vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(bound.current as never); vi.mocked(getPreviewBoot).mockResolvedValue(preview() as never);
  vi.mocked(putArtifact).mockResolvedValue(undefined); vi.mocked(signedGetUrl).mockResolvedValue("https://evidence.example.test/signed" as never);
  vi.mocked(appendChangeRecordEvent).mockImplementation(async (input) => ({ event: { payloadRef: input.payloadRef }, inserted: true }) as never);
});
afterEach(() => { for (const [key, value] of Object.entries(ORIGINAL_ENV)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

describe("POST /api/v1/runner/review-jobs/[jobId]/ui-executions/[executionId]/complete", () => {
  it("fails closed when screenshot storage is disabled before accepting a body", async () => {
    vi.mocked(storageConfigured).mockReturnValue(false);
    const bound = boundProof();
    expect((await POST(request(body(), bound.attempt.executionId), params(bound.attempt.executionId))).status).toBe(503);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled(); expect(putArtifact).not.toHaveBeenCalled();
  });

  it("requires an active bound session and an exact persisted attempt", async () => {
    const bound = boundProof();
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValueOnce(session({ conversationKey: "review-job:other" }) as never);
    expect((await POST(request(body(), bound.attempt.executionId), params(bound.attempt.executionId))).status).toBe(409);
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValueOnce(proof() as never);
    expect((await POST(request(body(), bound.attempt.executionId), params(bound.attempt.executionId))).status).toBe(409);
    expect(putArtifact).not.toHaveBeenCalled();
  });

  it("accepts only canonical bounded PNG or JPEG bytes before storage", async () => {
    const bound = boundProof();
    for (const invalid of [
      body({ imageBase64: "not-base64" }), body({ imageBase64: PNG, contentType: "image/jpeg" }),
      body({ imageBase64: TRUNCATED_PNG, contentType: "image/png" }),
      body({ imageBase64: TRUNCATED_JPEG, contentType: "image/jpeg" }),
      body({ imageBase64: Buffer.alloc(2 * 1024 * 1024 + 1, 1).toString("base64") }),
    ]) expect((await POST(request(invalid, bound.attempt.executionId), params(bound.attempt.executionId))).status).toBe(415);
    expect(putArtifact).not.toHaveBeenCalled();
    expect((await POST(request(body({ imageBase64: JPEG, contentType: "image/jpeg" }), bound.attempt.executionId), params(bound.attempt.executionId))).status).toBe(201);
  });

  it("requires the current exact preview boot, plan, and same browser origin before artifact custody", async () => {
    const bound = boundProof();
    expect((await POST(request(body({ observedUrl: "https://evil.example.test/" }), bound.attempt.executionId), params(bound.attempt.executionId))).status).toBe(409);
    vi.mocked(getPreviewBoot).mockResolvedValueOnce(preview({ headSha: "b".repeat(40) }) as never);
    expect((await POST(request(body(), bound.attempt.executionId), params(bound.attempt.executionId))).status).toBe(409);
    expect(putArtifact).not.toHaveBeenCalled();
  });

  it("derives result state, observation, evidence key, and receipt from the server-bound plan", async () => {
    const bound = boundProof();
    const result = buildReviewJobUiResult({ attempt: bound.attempt, plan: bound.plan, assertionPassed: false, artifactKey: "review-evidence/exact.png", contentType: "image/png", contentSha256: "7".repeat(64), observedUrl: "https://preview.example.test/filters?after=1" })!;
    const response = await POST(request(body({ assertionPassed: false }), bound.attempt.executionId), params(bound.attempt.executionId));
    expect(response.status).toBe(201);
    expect(putArtifact).toHaveBeenCalledWith("review-evidence/exact.png", expect.any(Buffer), "image/png");
    const reservation = vi.mocked(appendChangeRecordEvent).mock.calls[0]![0];
    expect(reservation).toMatchObject({
      recordId: "record-1",
      eventKey: reviewJobUiScreenshotReservationEventKey({ proof: bound.current, plan: bound.plan }),
      stage: "verification",
      actor: "jace:review-ui-executor",
      payloadRef: { kind: "review_job_ui_screenshot_upload_reservation", result: { ...result, contentSha256: expect.any(String) } },
    });
    const stored = vi.mocked(appendChangeRecordEvent).mock.calls[1]![0];
    expect(stored).toMatchObject({ recordId: "record-1", eventKey: reviewJobUiResultEventKey({ proof: bound.current, plan: bound.plan }), stage: "verification", actor: "jace:review-ui-executor" });
    expect(stored.payloadRef).toMatchObject({ ...result, contentSha256: expect.any(String) });
    expect((await response.json()).state).toBe("failed");
  });

  it("derives a path-safe storage segment instead of trusting the Contract criterion id", async () => {
    const current = proof([], "AC/../UI");
    const plan = current.verificationPlan.plans[0];
    const attempt = buildReviewJobUiAttempt({ proof: current, plan, boot: preview() })!;
    current.timeline.events = [timelineEvent(reviewJobUiAttemptEventKey({ proof: current, plan }), attempt)];
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValueOnce(current as never);
    vi.mocked(artifactKey).mockImplementationOnce((input) => {
      expect(input.acId).toMatch(/^ui-[a-f0-9]{48}-[a-f0-9]{16}$/u);
      expect(input.acId).not.toContain("AC/../UI");
      return "review-evidence/exact.png";
    });

    const response = await POST(request(body(), attempt.executionId), params(attempt.executionId));

    expect(response.status).toBe(201);
  });

  it("replays only an identical immutable receipt and holds conflicting result attempts", async () => {
    const bound = boundProof();
    const result = buildReviewJobUiResult({ attempt: bound.attempt, plan: bound.plan, assertionPassed: true, artifactKey: "review-evidence/exact.png", contentType: "image/png", contentSha256: createHash("sha256").update(Buffer.from(PNG, "base64")).digest("hex"), observedUrl: "https://preview.example.test/filters?after=1" })!;
    const reservation = buildReviewJobUiScreenshotReservation(result);
    const replayProof = proof([{ eventKey: reviewJobUiAttemptEventKey({ proof: bound.current, plan: bound.plan }), payloadRef: bound.attempt }, { eventKey: reviewJobUiScreenshotReservationEventKey({ proof: bound.current, plan: bound.plan }), payloadRef: reservation }, { eventKey: reviewJobUiResultEventKey({ proof: bound.current, plan: bound.plan }), payloadRef: result }]);
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValueOnce(replayProof as never);
    expect((await POST(request(body(), bound.attempt.executionId), params(bound.attempt.executionId))).status).toBe(200);
    expect(putArtifact).not.toHaveBeenCalled(); expect(signedGetUrl).toHaveBeenCalledWith("review-evidence/exact.png");
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValueOnce(proof([{ eventKey: reviewJobUiAttemptEventKey({ proof: bound.current, plan: bound.plan }), payloadRef: bound.attempt }, { eventKey: reviewJobUiScreenshotReservationEventKey({ proof: bound.current, plan: bound.plan }), payloadRef: reservation }, { eventKey: reviewJobUiResultEventKey({ proof: bound.current, plan: bound.plan }), payloadRef: { ...result, observed: "forged" } }]) as never);
    expect((await POST(request(body(), bound.attempt.executionId), params(bound.attempt.executionId))).status).toBe(409);
  });

  it("reserves the exact screenshot before storage and rejects a competing payload without writing bytes", async () => {
    const bound = boundProof();
    vi.mocked(appendChangeRecordEvent).mockResolvedValueOnce({
      event: { payloadRef: { kind: "review_job_ui_screenshot_upload_reservation", result: { artifactKey: "competing.png" } } },
      inserted: false,
    } as never);

    const response = await POST(request(body(), bound.attempt.executionId), params(bound.attempt.executionId));

    expect(response.status).toBe(409);
    expect(putArtifact).not.toHaveBeenCalled();
    expect(appendChangeRecordEvent).toHaveBeenCalledTimes(1);
  });

  it("reports store, receipt, and signing failures without claiming success", async () => {
    const bound = boundProof();
    vi.mocked(appendChangeRecordEvent).mockRejectedValueOnce(new Error("reservation down"));
    expect((await POST(request(body(), bound.attempt.executionId), params(bound.attempt.executionId))).status).toBe(503);
    expect(putArtifact).not.toHaveBeenCalled();

    vi.mocked(putArtifact).mockRejectedValueOnce(new Error("store down"));
    expect((await POST(request(body(), bound.attempt.executionId), params(bound.attempt.executionId))).status).toBe(500);

    vi.mocked(appendChangeRecordEvent)
      .mockImplementationOnce(async (input) => ({ event: { payloadRef: input.payloadRef }, inserted: false }) as never)
      .mockRejectedValueOnce(new Error("receipt down"));
    expect((await POST(request(body(), bound.attempt.executionId), params(bound.attempt.executionId))).status).toBe(503);

    vi.mocked(signedGetUrl).mockRejectedValueOnce(new Error("sign down"));
    expect((await POST(request(body(), bound.attempt.executionId), params(bound.attempt.executionId))).status).toBe(500);
  });
});

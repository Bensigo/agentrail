import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  resolveEvidenceVerificationPlanForArtifact: vi.fn(),
  recordEvidenceVerificationArtifact: vi.fn(),
}));
vi.mock("../../../../../lib/artifacts/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../../lib/artifacts/store")>()),
  putArtifact: vi.fn(),
  signedGetUrl: vi.fn(),
}));

import {
  recordEvidenceVerificationArtifact,
  resolveEvidenceVerificationPlanForArtifact,
} from "@agentrail/db-postgres";
import { putArtifact, signedGetUrl } from "../../../../../lib/artifacts/store";
import { POST } from "./route";

const secret = "secret";
const body = {
  workspaceId: "ws",
  recordId: "record",
  prRevisionId: "revision",
  verificationPlanId: "plan",
  collectedBy: "worker",
  index: 1,
  imageBase64: Buffer.from("image").toString("base64"),
  contentType: "image/png",
  observedUrl: "https://preview.example.test/widgets/42",
};
const request = (value: unknown = body, auth = true) => new NextRequest("http://localhost/api/v1/runner/evidence-verification-artifacts", {
  method: "POST",
  headers: { "content-type": "application/json", ...(auth ? { Authorization: `Bearer ${secret}` } : {}) },
  body: JSON.stringify(value),
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JACE_CONSOLE_TOKEN = secret;
  process.env.REVIEW_EVIDENCE_ENABLED = "1";
  process.env.S3_ENDPOINT = "http://localhost:9000";
  process.env.S3_ACCESS_KEY = "key";
  process.env.S3_SECRET_KEY = "secret";
  process.env.S3_BUCKET = "bucket";
  vi.mocked(resolveEvidenceVerificationPlanForArtifact).mockResolvedValue({
    plan: { id: "plan", criterionId: "save", environmentId: "preview-1" },
    repositoryFullName: "ada/widgets",
    prNumber: 42,
    headSha: "abcdef0123456789",
    previewUrl: "https://preview.example.test",
  } as never);
  vi.mocked(recordEvidenceVerificationArtifact).mockResolvedValue({
    id: "artifact", verificationPlanId: "plan", artifactKey: "review-evidence/ws/ada__widgets/42/abcdef0123456789/save-digest/1.png",
  } as never);
  vi.mocked(signedGetUrl).mockResolvedValue("https://signed.example/artifact" as never);
});

describe("verification artifact upload", () => {
  it("derives criterion and exact PR coordinates from the persisted UI plan", async () => {
    const response = await POST(request());

    expect(response.status).toBe(201);
    expect(resolveEvidenceVerificationPlanForArtifact).toHaveBeenCalledWith({ workspaceId: "ws", recordId: "record", prRevisionId: "revision", verificationPlanId: "plan", modality: "ui", requireReadyPreview: true });
    expect(recordEvidenceVerificationArtifact).toHaveBeenCalledWith(expect.objectContaining({ verificationPlanId: "plan", contentType: "image/png", contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    expect(putArtifact).toHaveBeenCalledTimes(1);
  });

  it("rejects caller coordinates when there is no current planned UI criterion", async () => {
    vi.mocked(resolveEvidenceVerificationPlanForArtifact).mockResolvedValue(null);

    expect((await POST(request())).status).toBe(409);
    expect(putArtifact).not.toHaveBeenCalled();
  });

  it("rejects a screenshot without the exact preview origin", async () => {
    expect((await POST(request({ ...body, observedUrl: "" }))).status).toBe(400);
    expect((await POST(request({ ...body, observedUrl: "https://untrusted.example.test/widgets/42" }))).status).toBe(409);
    expect(putArtifact).not.toHaveBeenCalled();
  });

  it("rejects unsupported content and oversized artifact indexes", async () => {
    expect((await POST(request({ ...body, contentType: "text/plain" }))).status).toBe(415);
    expect((await POST(request({ ...body, index: 11 }))).status).toBe(422);
  });

  it("fails closed without runner authentication", async () => {
    expect((await POST(request(body, false))).status).toBe(401);
    expect(resolveEvidenceVerificationPlanForArtifact).not.toHaveBeenCalled();
  });
});

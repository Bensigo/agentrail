import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { requireContextPackRegenerationWorkerSecret } from "./context-pack-regeneration-worker-auth";

const workerToken = "regeneration-worker-only";
const centralToken = "central-jace-only";

function request(token: string) {
  return new NextRequest("http://localhost/api/v1/runner/context-pack-regenerations/claim", {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("requireContextPackRegenerationWorkerSecret", () => {
  beforeEach(() => {
    process.env.JACE_CONTEXT_PACK_REGENERATION_WORKER_TOKEN = workerToken;
    process.env.JACE_CONSOLE_TOKEN = centralToken;
  });
  afterEach(() => {
    delete process.env.JACE_CONTEXT_PACK_REGENERATION_WORKER_TOKEN;
    delete process.env.JACE_CONSOLE_TOKEN;
  });

  it("accepts only the dedicated regeneration capability", () => {
    expect(requireContextPackRegenerationWorkerSecret(request(workerToken))).toBeNull();
    expect(requireContextPackRegenerationWorkerSecret(request(centralToken))).toBeInstanceOf(NextResponse);
  });

  it("fails closed when missing or accidentally equal to the central capability", () => {
    delete process.env.JACE_CONTEXT_PACK_REGENERATION_WORKER_TOKEN;
    expect((requireContextPackRegenerationWorkerSecret(request(workerToken)) as NextResponse).status).toBe(401);
    process.env.JACE_CONTEXT_PACK_REGENERATION_WORKER_TOKEN = centralToken;
    expect((requireContextPackRegenerationWorkerSecret(request(centralToken)) as NextResponse).status).toBe(401);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEPENDENCY_OBSERVATION_DRAFT_BODY_BYTES,
  DEPENDENCY_OBSERVATION_DRAFT_BODY_TIMEOUT_MS,
  parseDependencyObservationDraftLocator,
  readDependencyObservationDraftJson,
} from "./dependency-observation-draft";

const locator = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  watchId: "00000000-0000-4000-8000-000000000002",
  candidateFingerprint: `sha256:${"a".repeat(64)}`,
};

afterEach(() => vi.useRealTimers());

describe("dependency observation draft locator", () => {
  it("accepts only the three canonical locator fields", () => {
    expect(parseDependencyObservationDraftLocator(locator)).toEqual(locator);
    for (const value of [
      { ...locator, evidence: {} },
      { ...locator, repo: "acme/forged" },
      { ...locator, baselineSha: "forged" },
      { ...locator, candidateFingerprint: `sha256:${"A".repeat(64)}` },
      { ...locator, watchId: "not-a-uuid" },
      null,
      [],
    ]) expect(parseDependencyObservationDraftLocator(value)).toBeNull();
  });
});

describe("bounded dependency observation draft JSON", () => {
  it("reads one exact JSON object", async () => {
    const request = new Request("http://localhost/runner", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(locator),
    });
    await expect(readDependencyObservationDraftJson(request)).resolves.toEqual({
      ok: true,
      value: locator,
    });
  });

  it("refuses a declared or streamed overflow and cancels the stream", async () => {
    const declared = new Request("http://localhost/runner", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(DEPENDENCY_OBSERVATION_DRAFT_BODY_BYTES + 1),
      },
      body: "{}",
    });
    await expect(readDependencyObservationDraftJson(declared)).resolves.toEqual({
      ok: false,
      reason: "invalid_length",
    });

    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(DEPENDENCY_OBSERVATION_DRAFT_BODY_BYTES + 1));
      },
      cancel: cancelled,
    });
    const streamed = new Request("http://localhost/runner", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(readDependencyObservationDraftJson(streamed)).resolves.toEqual({
      ok: false,
      reason: "invalid_length",
    });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("keeps the timeout active through a stalled body", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
      pull: () => new Promise<void>(() => undefined),
      cancel: () => {
        cancelled = true;
      },
    });
    const request = new Request("http://localhost/runner", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const result = readDependencyObservationDraftJson(request);
    await vi.advanceTimersByTimeAsync(DEPENDENCY_OBSERVATION_DRAFT_BODY_TIMEOUT_MS);
    await expect(result).resolves.toEqual({ ok: false, reason: "timeout" });
    expect(cancelled).toBe(true);
  });

  it("refuses malformed media types and fatal UTF-8/JSON", async () => {
    const text = new Request("http://localhost/runner", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    await expect(readDependencyObservationDraftJson(text)).resolves.toEqual({
      ok: false,
      reason: "invalid_content_type",
    });
    const invalid = new Request("http://localhost/runner", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Uint8Array([0xc3, 0x28]),
    });
    await expect(readDependencyObservationDraftJson(invalid)).resolves.toEqual({
      ok: false,
      reason: "invalid_json",
    });
  });
});

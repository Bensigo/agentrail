import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./store", () => ({ signedGetUrl: vi.fn() }));

import { signedGetUrl } from "./store";
import { readBoundedArtifactForProxy } from "./proxy";

const artifactKey = "review-evidence/private/object.png";
const expectedBytes = new Uint8Array([1, 2, 3]);
const contentSha256 = createHash("sha256").update(expectedBytes).digest("hex");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(signedGetUrl).mockResolvedValue("https://objects.example.test/private-signed");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("readBoundedArtifactForProxy", () => {
  it("privately signs for 60 seconds and returns bounded bytes", async () => {
    const fetchImpl = vi.fn(async () => new Response(expectedBytes, {
      status: 200,
      headers: { "content-length": "3" },
    }));

    await expect(readBoundedArtifactForProxy({ artifactKey, contentSha256, fetchImpl })).resolves.toEqual({
      kind: "available",
      bytes: expectedBytes,
    });
    expect(signedGetUrl).toHaveBeenCalledWith(artifactKey, 60);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://objects.example.test/private-signed",
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
  });

  it("cancels an unavailable object response", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 404 }));

    await expect(readBoundedArtifactForProxy({ artifactKey, contentSha256, fetchImpl })).resolves.toEqual({
      kind: "unavailable",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels a streamed body that exceeds two MiB", async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(1024 * 1024 + 1);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel,
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));

    await expect(readBoundedArtifactForProxy({ artifactKey, contentSha256, fetchImpl })).resolves.toEqual({
      kind: "unavailable",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("aborts a stalled response body at the fixed timeout", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal as AbortSignal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          observedSignal?.addEventListener("abort", () => {
            controller.error(new DOMException("Aborted", "AbortError"));
          });
        },
      }), { status: 200 });
    });

    const pending = readBoundedArtifactForProxy({ artifactKey, contentSha256, fetchImpl });
    await vi.advanceTimersByTimeAsync(8_000);

    await expect(pending).resolves.toEqual({ kind: "unavailable" });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("fails closed when signing or fetching fails", async () => {
    vi.mocked(signedGetUrl).mockRejectedValueOnce(new Error("secret endpoint detail"));
    await expect(readBoundedArtifactForProxy({ artifactKey, contentSha256 })).resolves.toEqual({
      kind: "unavailable",
    });

    vi.mocked(signedGetUrl).mockResolvedValueOnce("https://objects.example.test/private-signed");
    const fetchImpl = vi.fn(async () => {
      throw new Error("network detail");
    });
    await expect(readBoundedArtifactForProxy({ artifactKey, contentSha256, fetchImpl })).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("fails closed when bounded bytes do not match the receipt digest", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([9, 9, 9]), {
      status: 200,
    }));

    await expect(readBoundedArtifactForProxy({
      artifactKey,
      contentSha256,
      fetchImpl,
    })).resolves.toEqual({ kind: "unavailable" });
  });
});

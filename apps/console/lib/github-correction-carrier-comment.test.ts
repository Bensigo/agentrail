import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  postGithubCorrectionCarrierComment,
  validateDbIssuedGithubCorrectionActivationBody,
} from "./github-correction-carrier-comment";

const TOKEN = "ghs_scoped_token";
const REPO = "acme/widgets";
const PR = 42;
const BODY = "## AgentRail correction finding\n\nOrdinary human-visible finding.";

function response(value: unknown, status = 201): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("postGithubCorrectionCarrierComment", () => {
  it("POSTs only the canonical PR timeline issue-comment path and accepts an exact 201 receipt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      id: 123,
      body: BODY,
      issue_url: `https://api.github.com/repos/${REPO}/issues/${PR}`,
      html_url: `https://github.com/${REPO}/pull/${PR}#issuecomment-123`,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await postGithubCorrectionCarrierComment({
      token: TOKEN, repo: REPO, prNumber: PR, kind: "finding", body: BODY,
    });
    expect(result).toMatchObject({ kind: "published", commentId: "123" });
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.github.com/repos/${REPO}/issues/${PR}/comments`,
      expect.objectContaining({ method: "POST", redirect: "error" })
    );
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ body: BODY });
  });

  it("rejects bad input and finding mentions before network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const input of [
      { token: TOKEN, repo: REPO, prNumber: PR, kind: "finding", body: `${BODY} @codex` },
      { token: TOKEN, repo: REPO, prNumber: PR, kind: "activation", body: `${BODY} @codex @claude` },
      { token: TOKEN, repo: "acme/widgets/../other", prNumber: PR, kind: "finding", body: BODY },
    ]) {
      await expect(postGithubCorrectionCarrierComment(input as never)).resolves.toEqual({
        kind: "known_failure", reason: "invalid_input",
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("holds ambiguous outcomes and never treats a mismatched 201 body as published", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      id: 123,
      body: `${BODY} changed`,
      issue_url: `https://api.github.com/repos/${REPO}/issues/${PR}`,
      html_url: `https://github.com/${REPO}/pull/${PR}#issuecomment-123`,
    })));
    await expect(postGithubCorrectionCarrierComment({
      token: TOKEN, repo: REPO, prNumber: PR, kind: "finding", body: BODY,
    })).resolves.toEqual({ kind: "unknown", reason: "ambiguous_response" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({}, 503)));
    await expect(postGithubCorrectionCarrierComment({
      token: TOKEN, repo: REPO, prNumber: PR, kind: "finding", body: BODY,
    })).resolves.toEqual({ kind: "unknown", reason: "github_unavailable" });
  });

  it("classifies a known GitHub rejection without exposing the token or raw response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ message: "forbidden" }, 422)));
    const result = await postGithubCorrectionCarrierComment({
      token: TOKEN, repo: REPO, prNumber: PR, kind: "finding", body: BODY,
    });
    expect(result).toEqual({ kind: "known_failure", reason: "github_rejected" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain("forbidden");
  });

  it("holds a stalled write as unknown after the bounded timeout without retrying", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener("abort", () => reject(new Error("aborted")));
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const pending = postGithubCorrectionCarrierComment({
      token: TOKEN, repo: REPO, prNumber: PR, kind: "finding", body: BODY,
    });
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(pending).resolves.toEqual({ kind: "unknown", reason: "github_unavailable" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("caps declared and streamed receipt bodies, cancelling over-limit streams", async () => {
    const declaredCancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      new ReadableStream<Uint8Array>({ cancel: declaredCancel }),
      { status: 201, headers: { "content-length": String(64 * 1024 + 1) } }
    )));
    await expect(postGithubCorrectionCarrierComment({
      token: TOKEN, repo: REPO, prNumber: PR, kind: "finding", body: BODY,
    })).resolves.toEqual({ kind: "unknown", reason: "ambiguous_response" });
    expect(declaredCancel).toHaveBeenCalledOnce();

    const streamedCancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(64 * 1024 + 1)); },
        cancel: streamedCancel,
      }),
      { status: 201 }
    )));
    await expect(postGithubCorrectionCarrierComment({
      token: TOKEN, repo: REPO, prNumber: PR, kind: "finding", body: BODY,
    })).resolves.toEqual({ kind: "unknown", reason: "ambiguous_response" });
    expect(streamedCancel).toHaveBeenCalledOnce();
  });

  it("keeps the timeout alive through a stalled receipt body", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
        new ReadableStream<Uint8Array>({
          pull: () => new Promise<void>(() => undefined),
          cancel,
        }),
        { status: 201 }
      )));
      const pending = postGithubCorrectionCarrierComment({
        token: TOKEN, repo: REPO, prNumber: PR, kind: "finding", body: BODY,
      });
      await vi.advanceTimersByTimeAsync(8_000);
      await expect(pending).resolves.toEqual({ kind: "unknown", reason: "ambiguous_response" });
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts only a bounded DB-issued activation body with its full packet bundle and one selected mention", () => {
    const bundle = Buffer.from('{"kind":"correction_packet_bundle"}', "utf8").toString("base64url");
    const digest = createHash("sha256").update(Buffer.from(bundle, "base64url")).digest("hex");
    const body = `## AgentRail correction activation\n\nBundle: ${bundle}\nSHA-256: ${digest}\n\n@claude`;
    expect(validateDbIssuedGithubCorrectionActivationBody({
      body, recipient: "claude", packetBundleBase64url: bundle, packetBundleSha256: digest,
    })).toBe(true);
    expect(validateDbIssuedGithubCorrectionActivationBody({
      body: `${body} @codex`, recipient: "claude", packetBundleBase64url: bundle, packetBundleSha256: digest,
    })).toBe(false);
    expect(validateDbIssuedGithubCorrectionActivationBody({
      body, recipient: "claude", packetBundleBase64url: bundle, packetBundleSha256: "a".repeat(64),
    })).toBe(false);
  });

  it("accepts a canonical bundle above the old 60,000-character false-failure boundary", () => {
    const bundleBytes = Buffer.alloc(45_001, 1);
    const bundle = bundleBytes.toString("base64url");
    expect(bundle.length).toBeGreaterThan(60_000);
    const digest = createHash("sha256").update(bundleBytes).digest("hex");
    const body = `@codex\n${bundle}\n${digest}`;
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(60 * 1024);
    expect(validateDbIssuedGithubCorrectionActivationBody({
      body, recipient: "codex", packetBundleBase64url: bundle, packetBundleSha256: digest,
    })).toBe(true);
  });
});

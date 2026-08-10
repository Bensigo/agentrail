import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_CURRENT_PR_RESPONSE_BYTES,
  readCurrentGithubPullRequest,
} from "./github-current-pr";

const TOKEN = "ghs-secret-installation-token";
const REPO = "ada/widgets";
const PR = 42;
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

function response(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function currentPr(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: PR,
    html_url: `https://github.com/${REPO}/pull/${PR}`,
    state: "open",
    merged: false,
    draft: false,
    head: { sha: HEAD },
    base: { sha: BASE, repo: { full_name: REPO } },
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("readCurrentGithubPullRequest", () => {
  it("reads one fixed-host canonical open PR and never returns its token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(currentPr()));
    vi.stubGlobal("fetch", fetchMock);

    const result = await readCurrentGithubPullRequest({ token: TOKEN, repo: REPO, prNumber: PR });

    expect(result).toEqual({
      ok: true,
      pullRequest: {
        repo: REPO,
        prNumber: PR,
        headSha: HEAD,
        baseSha: BASE,
        state: "open",
        draft: false,
        merged: false,
        htmlUrl: `https://github.com/${REPO}/pull/${PR}`,
      },
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.github.com/repos/${REPO}/pulls/${PR}`,
      expect.objectContaining({
        redirect: "error",
        headers: expect.objectContaining({ Authorization: `Bearer ${TOKEN}` }),
      })
    );
  });

  it.each([
    [{ token: "", repo: REPO, prNumber: PR }],
    [{ token: TOKEN, repo: "ada/widgets/../other", prNumber: PR }],
    [{ token: TOKEN, repo: REPO, prNumber: 0 }],
  ])("fails invalid input before fetch", async (input) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(readCurrentGithubPullRequest(input)).resolves.toEqual({
      ok: false, kind: "not_proven", reason: "invalid_input",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["closed", currentPr({ state: "closed", merged: false })],
    ["merged", currentPr({ state: "closed", merged: true })],
  ])("returns valid %s metadata for the DB's terminal fail-closed decision", async (_label, payload) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(payload)));
    await expect(readCurrentGithubPullRequest({ token: TOKEN, repo: REPO, prNumber: PR })).resolves.toEqual(expect.objectContaining({
      ok: true,
      pullRequest: expect.objectContaining({ state: "closed" }),
    }));
  });

  it.each([
    ["noncanonical URL", currentPr({ html_url: "https://evil.example/pr/42" })],
    ["wrong base repo", currentPr({ base: { sha: BASE, repo: { full_name: "ada/other" } } })],
    ["short head", currentPr({ head: { sha: "abc" } })],
    ["missing draft", (() => { const pr = currentPr(); delete pr.draft; return pr; })()],
    ["merged open PR", currentPr({ state: "open", merged: true })],
  ])("fails malformed %s metadata", async (_label, payload) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(payload)));
    await expect(readCurrentGithubPullRequest({ token: TOKEN, repo: REPO, prNumber: PR })).resolves.toEqual({
      ok: false, kind: "not_proven", reason: "invalid_pr_metadata",
    });
  });

  it("fails closed on a rejected, unavailable, or oversized response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({}, { status: 404 })));
    await expect(readCurrentGithubPullRequest({ token: TOKEN, repo: REPO, prNumber: PR })).resolves.toEqual({
      ok: false, kind: "not_proven", reason: "github_rejected",
    });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    await expect(readCurrentGithubPullRequest({ token: TOKEN, repo: REPO, prNumber: PR })).resolves.toEqual({
      ok: false, kind: "not_proven", reason: "github_unavailable",
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", {
      status: 200,
      headers: { "content-length": String(MAX_CURRENT_PR_RESPONSE_BYTES + 1) },
    })));
    await expect(readCurrentGithubPullRequest({ token: TOKEN, repo: REPO, prNumber: PR })).resolves.toEqual({
      ok: false, kind: "not_proven", reason: "invalid_pr_metadata",
    });
  });

  it("bounds a stalled fixed-host fetch at eight seconds without returning its token", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      (init.signal as AbortSignal).addEventListener("abort", () => reject(new Error("aborted")));
    }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = readCurrentGithubPullRequest({ token: TOKEN, repo: REPO, prNumber: PR });
    await vi.advanceTimersByTimeAsync(8_000);
    const result = await pending;

    expect(result).toEqual({ ok: false, kind: "not_proven", reason: "github_unavailable" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("cancels a streamed response that crosses the byte cap", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_CURRENT_PR_RESPONSE_BYTES + 1));
      },
      cancel,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));

    const result = await readCurrentGithubPullRequest({ token: TOKEN, repo: REPO, prNumber: PR });

    expect(result).toEqual({ ok: false, kind: "not_proven", reason: "invalid_pr_metadata" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

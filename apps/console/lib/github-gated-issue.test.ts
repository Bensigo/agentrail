import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { publishGithubGatedIssue } from "./github-gated-issue";

const TOKEN = "ghs_scoped_token";
const REPO = "acme/widgets";
const TITLE = "Acceptance correction required for acme/widgets#42";
const BODY = "Immutable correction packet receipts require repair and exact-head reverification.";
const REQUEST_ID = "A1B2:3C4D:5E6F:7890";

function response(value: unknown, status = 201, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "x-github-request-id": REQUEST_ID, ...headers },
  });
}

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 123456,
    number: 17,
    url: `https://api.github.com/repos/${REPO}/issues/17`,
    html_url: `https://github.com/${REPO}/issues/17`,
    title: TITLE,
    body: BODY,
    state: "open",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("publishGithubGatedIssue", () => {
  it("POSTs exactly one unlabeled issue and returns the exact canonical 201 receipt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(receipt()));
    vi.stubGlobal("fetch", fetchMock);

    await expect(publishGithubGatedIssue({ token: TOKEN, repo: REPO, title: TITLE, body: BODY }))
      .resolves.toEqual({
        kind: "github_201",
        httpStatus: 201,
        githubIssueId: "123456",
        githubIssueNumber: 17,
        githubApiUrl: `https://api.github.com/repos/${REPO}/issues/17`,
        githubIssueUrl: `https://github.com/${REPO}/issues/17`,
        githubRequestId: REQUEST_ID,
        responseTitleSha256: createHash("sha256").update(TITLE).digest("hex"),
        responseBodySha256: createHash("sha256").update(BODY).digest("hex"),
        state: "open",
      });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.github.com/repos/${REPO}/issues`,
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(request.body as string)).toEqual({ title: TITLE, body: BODY });
    expect(Object.keys(JSON.parse(request.body as string))).toEqual(["title", "body"]);
    expect(request.body).not.toContain("labels");
    expect(request.body).not.toContain("assignees");
  });

  it("rejects malformed DB-issued request data and mentions before network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const input of [
      { token: TOKEN, repo: "acme/widgets/other", title: TITLE, body: BODY },
      { token: TOKEN, repo: REPO, title: `${TITLE} @codex`, body: BODY },
      { token: TOKEN, repo: REPO, title: TITLE, body: `${BODY} @claude` },
      { token: TOKEN, repo: REPO, title: `${TITLE}\t`, body: BODY },
      { token: TOKEN, repo: REPO, title: TITLE, body: `${BODY}\r\ncontinued` },
      { token: TOKEN, repo: REPO, title: TITLE, body: `${BODY}\tcontinued` },
      { token: TOKEN, repo: REPO, title: "x".repeat(257), body: BODY },
      { token: TOKEN, repo: REPO, title: TITLE, body: "x".repeat(24 * 1024 + 1) },
    ]) {
      await expect(publishGithubGatedIssue(input)).resolves.toEqual({
        kind: "bounded_failed",
        reason: "invalid_db_issued_request",
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps every 4xx to a bounded failure and cancels its body", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      new ReadableStream<Uint8Array>({ cancel }),
      { status: 422 },
    )));
    await expect(publishGithubGatedIssue({ token: TOKEN, repo: REPO, title: TITLE, body: BODY }))
      .resolves.toEqual({ kind: "bounded_failed", reason: "github_rejected" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("holds network, 5xx, malformed, and mismatched 201 outcomes without retrying", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("network"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(publishGithubGatedIssue({ token: TOKEN, repo: REPO, title: TITLE, body: BODY }))
      .resolves.toEqual({ kind: "ambiguous_hold", reason: "github_unavailable" });

    fetchMock.mockResolvedValueOnce(response({}, 503));
    await expect(publishGithubGatedIssue({ token: TOKEN, repo: REPO, title: TITLE, body: BODY }))
      .resolves.toEqual({ kind: "ambiguous_hold", reason: "github_unavailable" });

    fetchMock.mockResolvedValueOnce(response(receipt({ body: `${BODY} changed` })));
    await expect(publishGithubGatedIssue({ token: TOKEN, repo: REPO, title: TITLE, body: BODY }))
      .resolves.toEqual({ kind: "ambiguous_hold", reason: "ambiguous_response" });

    fetchMock.mockResolvedValueOnce(response(receipt(), 201, { "x-github-request-id": "" }));
    await expect(publishGithubGatedIssue({ token: TOKEN, repo: REPO, title: TITLE, body: BODY }))
      .resolves.toEqual({ kind: "ambiguous_hold", reason: "ambiguous_response" });

    fetchMock.mockResolvedValueOnce(response(receipt(), 201, { "x-github-request-id": "BAD_ID" }));
    await expect(publishGithubGatedIssue({ token: TOKEN, repo: REPO, title: TITLE, body: BODY }))
      .resolves.toEqual({ kind: "ambiguous_hold", reason: "ambiguous_response" });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(receipt()), {
      status: 201,
      headers: { "content-type": "text/plain", "x-github-request-id": REQUEST_ID },
    }));
    await expect(publishGithubGatedIssue({ token: TOKEN, repo: REPO, title: TITLE, body: BODY }))
      .resolves.toEqual({ kind: "ambiguous_hold", reason: "ambiguous_response" });

    fetchMock.mockResolvedValueOnce(new Response("{", {
      status: 201,
      headers: { "content-type": "application/json", "x-github-request-id": REQUEST_ID },
    }));
    await expect(publishGithubGatedIssue({ token: TOKEN, repo: REPO, title: TITLE, body: BODY }))
      .resolves.toEqual({ kind: "ambiguous_hold", reason: "ambiguous_response" });
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it("holds a stalled write at eight seconds without retrying", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener("abort", () => reject(new Error("aborted")));
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const pending = publishGithubGatedIssue({ token: TOKEN, repo: REPO, title: TITLE, body: BODY });
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(pending).resolves.toEqual({ kind: "ambiguous_hold", reason: "github_unavailable" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("caps declared and streamed 201 response bodies and cancels overflow", async () => {
    const declaredCancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      new ReadableStream<Uint8Array>({ cancel: declaredCancel }),
      { status: 201, headers: {
        "content-length": String(64 * 1024 + 1),
        "content-type": "application/json",
      } },
    )));
    await expect(publishGithubGatedIssue({ token: TOKEN, repo: REPO, title: TITLE, body: BODY }))
      .resolves.toEqual({ kind: "ambiguous_hold", reason: "ambiguous_response" });
    expect(declaredCancel).toHaveBeenCalledOnce();

    const streamedCancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(64 * 1024 + 1)); },
        cancel: streamedCancel,
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    )));
    await expect(publishGithubGatedIssue({ token: TOKEN, repo: REPO, title: TITLE, body: BODY }))
      .resolves.toEqual({ kind: "ambiguous_hold", reason: "ambiguous_response" });
    expect(streamedCancel).toHaveBeenCalledOnce();
  });

  it("keeps the timeout active through a stalled 201 body", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
        cancel,
      }),
      { status: 201, headers: {
        "content-type": "application/json",
        "x-github-request-id": REQUEST_ID,
      } },
    )));
    const pending = publishGithubGatedIssue({ token: TOKEN, repo: REPO, title: TITLE, body: BODY });
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(pending).resolves.toEqual({ kind: "ambiguous_hold", reason: "ambiguous_response" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels a 201 body when fetch resolves only after the fixed signal is already aborted", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() =>
      new Promise<Response>((resolve) => {
        setTimeout(() => resolve(new Response(
          new ReadableStream<Uint8Array>({
            pull: () => new Promise<void>(() => undefined),
            cancel,
          }),
          { status: 201, headers: {
            "content-type": "application/json",
            "x-github-request-id": REQUEST_ID,
          } },
        )), 8_001);
      }),
    ));
    const pending = publishGithubGatedIssue({ token: TOKEN, repo: REPO, title: TITLE, body: BODY });
    await vi.advanceTimersByTimeAsync(8_001);
    await expect(pending).resolves.toEqual({ kind: "ambiguous_hold", reason: "ambiguous_response" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});

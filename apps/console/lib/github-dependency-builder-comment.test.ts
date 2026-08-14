import { afterEach, describe, expect, it, vi } from "vitest";
import { postGithubDependencyBuilderComment } from "./github-dependency-builder-comment";

const input = {
  token: "ghs_scoped_token",
  repo: "acme/widgets",
  prNumber: 42,
  body: "@claude\n\nJace initial dependency handoff.\nDelivery: 11111111-1111-4111-8111-111111111111",
};

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("postGithubDependencyBuilderComment", () => {
  it("accepts only an exact bounded 201 receipt from the canonical comment path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 901,
      body: input.body,
      issue_url: "https://api.github.com/repos/acme/widgets/issues/42",
    }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(postGithubDependencyBuilderComment(input)).resolves.toMatchObject({
      kind: "published",
      commentId: "901",
      commentUrl: "https://github.com/acme/widgets/pull/42#issuecomment-901",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.github.com/repos/acme/widgets/issues/42/comments");
  });

  it("rejects extra mentions before network and holds a mismatched receipt without retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 901,
      body: `${input.body} changed`,
      issue_url: "https://api.github.com/repos/acme/widgets/issues/42",
    }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(postGithubDependencyBuilderComment({ ...input, body: `${input.body}\n@codex` }))
      .resolves.toEqual({ kind: "known_failure", reason: "invalid_input" });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(postGithubDependencyBuilderComment(input))
      .resolves.toEqual({ kind: "unknown", reason: "ambiguous_response" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("holds a timed-out write and performs exactly one POST", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener("abort", () => reject(new Error("aborted")));
      }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = postGithubDependencyBuilderComment(input);
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(pending).resolves.toEqual({ kind: "unknown", reason: "github_unavailable" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

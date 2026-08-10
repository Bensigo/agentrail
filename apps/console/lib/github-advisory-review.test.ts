import { afterEach, describe, expect, it, vi } from "vitest";
import { postGithubAdvisoryReview } from "./github-advisory-review";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("postGithubAdvisoryReview", () => {
  it("hardcodes COMMENT and posts only the server-derived target", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response(200, { html_url: "https://github.com/ada/widgets/pull/7#review-1" })
    );
    global.fetch = fetchMock as typeof fetch;

    const result = await postGithubAdvisoryReview({
      repo: "ada/widgets",
      prNumber: 7,
      headSha: "abc123",
      token: "ghs-secret",
      summary: "Evidence checked.",
      comments: [{ path: "src/a.ts", line: 4, body: "Blocking issue." }],
    });

    expect(result).toMatchObject({ ok: true, inlineCommentsPosted: 1 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/ada/widgets/pulls/7/reviews");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer ghs-secret"
    );
    expect(JSON.parse(init.body as string)).toEqual({
      body: "Evidence checked.",
      commit_id: "abc123",
      event: "COMMENT",
      comments: [
        { path: "src/a.ts", line: 4, side: "RIGHT", body: "Blocking issue." },
      ],
    });
  });

  it("folds all inline comments and retries only once on 422", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(422, { message: "bad line" }))
      .mockResolvedValueOnce(response(200, { html_url: "https://github.com/review-2" }));
    global.fetch = fetchMock as typeof fetch;

    const result = await postGithubAdvisoryReview({
      repo: "ada/widgets",
      prNumber: 7,
      headSha: "abc123",
      token: "token",
      summary: "Summary",
      comments: [{ path: "src/a.ts", line: 4, body: "Blocking issue." }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: true, inlineCommentsPosted: 0 });
    if (!result.ok) throw new Error("expected success");
    expect(result.foldedComments).toHaveLength(1);
    const retry = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(retry.event).toBe("COMMENT");
    expect(retry.commit_id).toBe("abc123");
    expect(retry.comments).toBeUndefined();
    expect(retry.body).toContain("src/a.ts:4");
  });

  it("classifies network and credential failures without leaking the token", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Bearer secret")) as typeof fetch;
    await expect(
      postGithubAdvisoryReview({
        repo: "ada/widgets",
        prNumber: 7,
        headSha: "abc123",
        token: "secret",
        summary: "Summary",
        comments: [],
      })
    ).resolves.toEqual({ ok: false, status: 502, error: "Could not reach GitHub." });

    global.fetch = vi
      .fn()
      .mockResolvedValue(response(403, { message: "Bad credentials secret" })) as typeof fetch;
    const credential = await postGithubAdvisoryReview({
      repo: "ada/widgets",
      prNumber: 7,
      headSha: "abc123",
      token: "secret",
      summary: "Summary",
      comments: [],
    });
    expect(credential).toMatchObject({ ok: false, status: 409 });
    expect(JSON.stringify(credential)).not.toContain("secret");
  });

  it.each([
    ["missing", {}],
    ["blank", { html_url: "   " }],
    ["non-string", { html_url: 42 }],
  ])(
    "fails closed on a 2xx response with a %s review receipt",
    async (_label, body) => {
      global.fetch = vi.fn().mockResolvedValue(response(200, body)) as typeof fetch;

      await expect(
        postGithubAdvisoryReview({
          repo: "ada/widgets",
          prNumber: 7,
          headSha: "abc123",
          token: "secret",
          summary: "Summary",
          comments: [],
        })
      ).resolves.toEqual({
        ok: false,
        status: 502,
        error: "GitHub returned no inspectable review receipt.",
      });
    }
  );
});

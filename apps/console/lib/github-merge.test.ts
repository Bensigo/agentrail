import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseGithubPrUrl,
  repoSlugFromExternalId,
  prUrlMatchesQueueEntryRepo,
  mergePullRequestSquash,
} from "./github-merge";

const TOKEN = "gho_" + "a".repeat(36);

function githubResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ sha: "abc123", merged: true, message: "ok", ...overrides }),
  };
}

function githubErrorResponse(status: number, body: Record<string, unknown> = {}) {
  return {
    ok: false,
    status,
    json: async () => body,
  };
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

function mockFetchOnce(response: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValueOnce(response);
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe("parseGithubPrUrl", () => {
  it("parses a well-formed PR URL", () => {
    expect(parseGithubPrUrl("https://github.com/octocat/hello-world/pull/42")).toEqual({
      owner: "octocat",
      repo: "hello-world",
      number: 42,
    });
  });

  it("rejects http (non-https)", () => {
    expect(parseGithubPrUrl("http://github.com/octocat/hello-world/pull/42")).toBeNull();
  });

  it("rejects a lookalike host (e.g. github.com.evil.com)", () => {
    expect(
      parseGithubPrUrl("https://github.com.evil.com/octocat/hello-world/pull/42")
    ).toBeNull();
  });

  it("rejects a lookalike subdomain (e.g. api.github.com)", () => {
    expect(
      parseGithubPrUrl("https://api.github.com/octocat/hello-world/pull/42")
    ).toBeNull();
  });

  it("rejects a non-PR path (e.g. an issue URL)", () => {
    expect(parseGithubPrUrl("https://github.com/octocat/hello-world/issues/42")).toBeNull();
  });

  it("rejects extra path segments after the PR number", () => {
    expect(
      parseGithubPrUrl("https://github.com/octocat/hello-world/pull/42/files")
    ).toBeNull();
  });

  it("rejects a non-numeric or trailing-garbage PR number", () => {
    expect(parseGithubPrUrl("https://github.com/octocat/hello-world/pull/abc")).toBeNull();
    expect(parseGithubPrUrl("https://github.com/octocat/hello-world/pull/42abc")).toBeNull();
  });

  it("rejects junk / non-URL input", () => {
    expect(parseGithubPrUrl("not a url")).toBeNull();
    expect(parseGithubPrUrl("")).toBeNull();
    expect(parseGithubPrUrl("javascript:alert(1)")).toBeNull();
  });

  // #1343 minor (b): bound the PR number to a JS safe integer, mirroring
  // parseOutcomeIssueNumber (apps/console/lib/outcome-format.ts) — an
  // unbounded `\d+` run would otherwise interpolate a huge/imprecise number
  // into the GitHub API path URL mergePullRequestSquash builds.
  it("rejects a PR number beyond Number.MAX_SAFE_INTEGER (a 24-digit run)", () => {
    expect(
      parseGithubPrUrl(
        "https://github.com/octocat/hello-world/pull/123456789012345678901234"
      )
    ).toBeNull();
  });

  it("accepts a PR number AT the safe-integer boundary", () => {
    expect(
      parseGithubPrUrl(
        `https://github.com/octocat/hello-world/pull/${Number.MAX_SAFE_INTEGER}`
      )
    ).toEqual({ owner: "octocat", repo: "hello-world", number: Number.MAX_SAFE_INTEGER });
  });

  it("rejects a PR number one past the safe-integer boundary", () => {
    expect(
      parseGithubPrUrl(
        `https://github.com/octocat/hello-world/pull/${Number.MAX_SAFE_INTEGER + 2}`
      )
    ).toBeNull();
  });

  // #1343 minor (c): the doc-comment now says query/hash ARE tolerated (the
  // match is against pathname only) — pin that actual, intentional behavior.
  it("tolerates a query string after the PR number (matches pathname only, per the doc-comment)", () => {
    expect(
      parseGithubPrUrl("https://github.com/octocat/hello-world/pull/42?tab=files")
    ).toEqual({ owner: "octocat", repo: "hello-world", number: 42 });
  });

  it("tolerates a hash fragment after the PR number (matches pathname only, per the doc-comment)", () => {
    expect(
      parseGithubPrUrl("https://github.com/octocat/hello-world/pull/42#discussion_r1")
    ).toEqual({ owner: "octocat", repo: "hello-world", number: 42 });
  });
});

describe("repoSlugFromExternalId", () => {
  it("extracts owner/repo from the enqueueGithubIssue shape, lowercased", () => {
    expect(repoSlugFromExternalId("Octocat/Hello-World#42")).toBe("octocat/hello-world");
  });

  it("returns null for an onboard-kind external id (no issue-number suffix)", () => {
    expect(repoSlugFromExternalId("onboard:octocat/hello-world")).toBeNull();
  });

  it("returns null for a bare cli/linear-shaped id with no repo slug", () => {
    expect(repoSlugFromExternalId("cli-42")).toBeNull();
    expect(repoSlugFromExternalId("LIN-123")).toBeNull();
  });
});

describe("prUrlMatchesQueueEntryRepo (the security gate)", () => {
  it("true when the PR's owner/repo exactly matches the queue entry's own repo", () => {
    expect(
      prUrlMatchesQueueEntryRepo(
        "https://github.com/octocat/hello-world/pull/42",
        "octocat/hello-world#42"
      )
    ).toBe(true);
  });

  it("true case-insensitively (GitHub slugs are case-insensitive)", () => {
    expect(
      prUrlMatchesQueueEntryRepo(
        "https://github.com/Octocat/Hello-World/pull/42",
        "octocat/hello-world#42"
      )
    ).toBe(true);
  });

  it("false when the PR points at a DIFFERENT repo than the queue entry (forgery attempt)", () => {
    expect(
      prUrlMatchesQueueEntryRepo(
        "https://github.com/attacker/evil-repo/pull/1",
        "octocat/hello-world#42"
      )
    ).toBe(false);
  });

  it("false for a lookalike host, even with a matching-looking path", () => {
    expect(
      prUrlMatchesQueueEntryRepo(
        "https://github.evil.com/octocat/hello-world/pull/42",
        "octocat/hello-world#42"
      )
    ).toBe(false);
  });

  it("false for junk pr_url", () => {
    expect(prUrlMatchesQueueEntryRepo("not a url", "octocat/hello-world#42")).toBe(false);
  });

  it("false when the queue entry's own externalId doesn't encode a repo (onboard/cli/linear)", () => {
    expect(
      prUrlMatchesQueueEntryRepo(
        "https://github.com/octocat/hello-world/pull/42",
        "onboard:octocat/hello-world"
      )
    ).toBe(false);
  });
});

describe("mergePullRequestSquash", () => {
  const PARSED = { owner: "octocat", repo: "hello-world", number: 42 };

  it("squash-merges via the exact REST call: PUT, correct URL, token in the Authorization header (never the URL/body)", async () => {
    const fetchMock = mockFetchOnce(githubResponse());

    const result = await mergePullRequestSquash(TOKEN, PARSED);

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/octocat/hello-world/pulls/42/merge");
    expect(url).not.toContain(TOKEN);
    expect(init.method).toBe("PUT");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(init.body as string);
    expect(body.merge_method).toBe("squash");
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it("405 (not mergeable — conflicts/blocking checks) is reported as not_mergeable, not a crash", async () => {
    mockFetchOnce(githubErrorResponse(405, { message: "Pull Request is not mergeable" }));

    const result = await mergePullRequestSquash(TOKEN, PARSED);

    expect(result).toEqual({ ok: false, reason: "not_mergeable", status: 405 });
  });

  it("409 (head sha moved / already merged) is reported as not_mergeable", async () => {
    mockFetchOnce(githubErrorResponse(409, { message: "Head branch was modified" }));

    const result = await mergePullRequestSquash(TOKEN, PARSED);

    expect(result).toEqual({ ok: false, reason: "not_mergeable", status: 409 });
  });

  it("an unrelated failure status (403/422/500) is reported as unexpected_response — never thrown", async () => {
    mockFetchOnce(githubErrorResponse(403, { message: "Forbidden" }));
    const result = await mergePullRequestSquash(TOKEN, PARSED);
    expect(result).toEqual({ ok: false, reason: "unexpected_response", status: 403 });
  });

  it("a 200 whose body doesn't actually say merged:true is reported as unexpected_response", async () => {
    mockFetchOnce(githubResponse({ merged: false }));
    const result = await mergePullRequestSquash(TOKEN, PARSED);
    expect(result).toEqual({ ok: false, reason: "unexpected_response", status: 200 });
  });

  it("a transport throw (network down / timeout) is swallowed into network_error, never thrown", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

    const result = await mergePullRequestSquash(TOKEN, PARSED);

    expect(result).toEqual({ ok: false, reason: "network_error" });
  });

  it("never surfaces the token in a failure result (closed-union reason only)", async () => {
    mockFetchOnce(githubErrorResponse(500, { message: `token was ${TOKEN}` }));

    const result = await mergePullRequestSquash(TOKEN, PARSED);

    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

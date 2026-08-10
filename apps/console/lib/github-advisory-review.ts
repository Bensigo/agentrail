const GITHUB_FETCH_TIMEOUT_MS = 8_000;

export interface AdvisoryReviewComment {
  path: string;
  line: number;
  body: string;
}

export type AdvisoryReviewPostResult =
  | {
      ok: true;
      reviewUrl: string;
      summary: string;
      inlineCommentsPosted: number;
      foldedComments: AdvisoryReviewComment[];
    }
  | { ok: false; status: number; error: string };

function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "agentrail-console",
  };
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function message(body: unknown): string {
  return body &&
    typeof body === "object" &&
    typeof (body as Record<string, unknown>).message === "string"
    ? ((body as Record<string, unknown>).message as string)
    : "";
}

function githubFailure(status: number, body: unknown): AdvisoryReviewPostResult {
  if (!Number.isFinite(status) || status <= 0) {
    return { ok: false, status: 502, error: "Could not reach GitHub." };
  }
  if (status === 404) return { ok: false, status: 404, error: "PR not found" };
  if (status === 429 || (status === 403 && /rate limit/i.test(message(body)))) {
    return {
      ok: false,
      status: 429,
      error: "GitHub rate limit exceeded — try again later",
    };
  }
  if (status === 401 || status === 403) {
    return {
      ok: false,
      status: 409,
      error:
        "GitHub rejected the workspace's App installation credentials — reconnect GitHub from the console",
    };
  }
  return {
    ok: false,
    status: 502,
    error: `GitHub rejected the request (HTTP ${status}).`,
  };
}

function foldComments(
  summary: string,
  comments: AdvisoryReviewComment[]
): string {
  const folded = comments
    .map((comment) => `- \`${comment.path}:${comment.line}\`: ${comment.body}`)
    .join("\n");
  const header =
    "**Additional comments (could not be attached to a specific diff line):**";
  return summary.trim()
    ? `${summary}\n\n---\n${header}\n${folded}`
    : `${header}\n${folded}`;
}

function post(
  repo: string,
  prNumber: number,
  headSha: string,
  token: string,
  summary: string,
  comments: AdvisoryReviewComment[]
): Promise<Response> {
  return fetchWithTimeout(
    `https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews`,
    {
      method: "POST",
      headers: githubHeaders(token),
      body: JSON.stringify({
        body: summary,
        // Bind the GitHub review object itself to the exact commit that the
        // server-owned review job inspected. Without commit_id GitHub defaults
        // to whichever PR head is current when this request arrives.
        commit_id: headSha,
        // Review-job automation is advisory by construction. No caller can
        // turn this into APPROVE or REQUEST_CHANGES.
        event: "COMMENT",
        ...(comments.length
          ? {
              comments: comments.map((comment) => ({
                path: comment.path,
                line: comment.line,
                side: "RIGHT",
                body: comment.body,
              })),
            }
          : {}),
      }),
    }
  );
}

/** Post one advisory review, folding all inline comments on GitHub 422. */
export async function postGithubAdvisoryReview(input: {
  repo: string;
  prNumber: number;
  headSha: string;
  token: string;
  summary: string;
  comments: AdvisoryReviewComment[];
}): Promise<AdvisoryReviewPostResult> {
  let response: Response;
  try {
    response = await post(
      input.repo,
      input.prNumber,
      input.headSha,
      input.token,
      input.summary,
      input.comments
    );
  } catch {
    return { ok: false, status: 502, error: "Could not reach GitHub." };
  }

  let finalSummary = input.summary;
  let foldedComments: AdvisoryReviewComment[] = [];
  if (response.status === 422) {
    foldedComments = input.comments;
    finalSummary = foldComments(input.summary, input.comments);
    try {
      response = await post(
        input.repo,
        input.prNumber,
        input.headSha,
        input.token,
        finalSummary,
        []
      );
    } catch {
      return { ok: false, status: 502, error: "Could not reach GitHub." };
    }
  }

  if (!response.ok) {
    return githubFailure(
      response.status,
      await response.json().catch(() => null)
    );
  }
  const body = (await response.json().catch(() => null)) as
    | { html_url?: unknown }
    | null;
  const reviewUrl =
    typeof body?.html_url === "string" && body.html_url.trim()
      ? body.html_url.trim()
      : null;
  if (!reviewUrl) {
    return {
      ok: false,
      status: 502,
      error: "GitHub returned no inspectable review receipt.",
    };
  }
  return {
    ok: true,
    reviewUrl,
    summary: finalSummary,
    inlineCommentsPosted: foldedComments.length ? 0 : input.comments.length,
    foldedComments,
  };
}

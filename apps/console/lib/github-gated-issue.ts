import { createHash } from "node:crypto";

const GITHUB_API = "https://api.github.com";
const GITHUB_WEB = "https://github.com";
const GITHUB_FETCH_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_TITLE_BYTES = 256;
const MAX_BODY_BYTES = 24 * 1024;
const REPOSITORY = /^([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})$/u;
const TOKEN = /^[A-Za-z0-9_.-]{1,8192}$/u;
const REQUEST_ID = /^[A-Za-z0-9:-]{1,128}$/u;
const TITLE_CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;
const BODY_CONTROL_OR_FORMAT = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\p{Cf}]/u;

export type GithubGatedIssueInput = {
  token: string;
  repo: string;
  title: string;
  body: string;
};

export type GithubGatedIssuePublicationResult =
  | {
      kind: "github_201";
      httpStatus: 201;
      githubIssueId: string;
      githubIssueNumber: number;
      githubApiUrl: string;
      githubIssueUrl: string;
      githubRequestId: string;
      responseTitleSha256: string;
      responseBodySha256: string;
      state: "open";
    }
  | {
      kind: "bounded_failed";
      reason: "invalid_db_issued_request" | "github_rejected";
    }
  | {
      kind: "ambiguous_hold";
      reason: "github_unavailable" | "ambiguous_response";
    };

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isValidInput(value: unknown): value is GithubGatedIssueInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 4
    || typeof input.token !== "string" || !TOKEN.test(input.token)
    || typeof input.repo !== "string"
    || typeof input.title !== "string" || Buffer.byteLength(input.title, "utf8") === 0
    || Buffer.byteLength(input.title, "utf8") > MAX_TITLE_BYTES
    || typeof input.body !== "string" || Buffer.byteLength(input.body, "utf8") === 0
    || Buffer.byteLength(input.body, "utf8") > MAX_BODY_BYTES
    || TITLE_CONTROL_OR_FORMAT.test(input.title) || BODY_CONTROL_OR_FORMAT.test(input.body)
    || input.title.includes("@") || input.body.includes("@")
  ) return false;
  const match = REPOSITORY.exec(input.repo);
  return match !== null && match[1] !== "." && match[1] !== ".."
    && match[2] !== "." && match[2] !== "..";
}

async function readBoundedJson(
  response: Response,
  controller: AbortController,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null
    && (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_RESPONSE_BYTES)) {
    void response.body?.cancel().catch(() => undefined);
    return { ok: false };
  }
  if (!response.body) return { ok: false };

  const reader = response.body.getReader();
  let rejectAbort!: (reason?: unknown) => void;
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
    rejectAbort(new Error("GitHub issue response timed out"));
  };
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  if (controller.signal.aborted) onAbort();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await Promise.race([reader.read(), aborted]);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        return { ok: false };
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      ok: true,
      value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    };
  } catch {
    return { ok: false };
  } finally {
    controller.signal.removeEventListener("abort", onAbort);
  }
}

function hasJsonContentType(response: Response): boolean {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return contentType === "application/json"
    || (contentType?.startsWith("application/") === true && contentType.endsWith("+json"));
}

function exactReceipt(
  value: unknown,
  input: GithubGatedIssueInput,
  requestId: string | null,
): GithubGatedIssuePublicationResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || requestId === null || !REQUEST_ID.test(requestId)) return null;
  const receipt = value as Record<string, unknown>;
  if (typeof receipt.id !== "number" || !Number.isSafeInteger(receipt.id) || receipt.id <= 0
    || typeof receipt.number !== "number" || !Number.isSafeInteger(receipt.number)
    || receipt.number <= 0 || receipt.title !== input.title || receipt.body !== input.body
    || receipt.state !== "open" || "pull_request" in receipt) return null;
  const githubApiUrl = `${GITHUB_API}/repos/${input.repo}/issues/${receipt.number}`;
  const githubIssueUrl = `${GITHUB_WEB}/${input.repo}/issues/${receipt.number}`;
  if (receipt.url !== githubApiUrl || receipt.html_url !== githubIssueUrl) return null;
  return {
    kind: "github_201",
    httpStatus: 201,
    githubIssueId: String(receipt.id),
    githubIssueNumber: receipt.number,
    githubApiUrl,
    githubIssueUrl,
    githubRequestId: requestId,
    responseTitleSha256: sha256(input.title),
    responseBodySha256: sha256(input.body),
    state: "open",
  };
}

/**
 * Publishes one DB-issued, unlabeled GitHub issue and never retries an
 * uncertain write. Because the request contains exactly title/body, the
 * repository's trigger-label webhook gate cannot enqueue it into the factory.
 */
export async function publishGithubGatedIssue(
  input: GithubGatedIssueInput,
): Promise<GithubGatedIssuePublicationResult> {
  if (!isValidInput(input)) {
    return { kind: "bounded_failed", reason: "invalid_db_issued_request" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(`${GITHUB_API}/repos/${input.repo}/issues`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "agentrail-console",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ title: input.title, body: input.body }),
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      return { kind: "ambiguous_hold", reason: "github_unavailable" };
    }

    if (response.status !== 201) {
      void response.body?.cancel().catch(() => undefined);
      return response.status >= 400 && response.status < 500
        ? { kind: "bounded_failed", reason: "github_rejected" }
        : { kind: "ambiguous_hold", reason: "github_unavailable" };
    }
    if (!hasJsonContentType(response)) {
      void response.body?.cancel().catch(() => undefined);
      return { kind: "ambiguous_hold", reason: "ambiguous_response" };
    }
    const parsed = await readBoundedJson(response, controller);
    if (!parsed.ok) return { kind: "ambiguous_hold", reason: "ambiguous_response" };
    return exactReceipt(parsed.value, input, response.headers.get("x-github-request-id"))
      ?? { kind: "ambiguous_hold", reason: "ambiguous_response" };
  } finally {
    clearTimeout(timer);
  }
}

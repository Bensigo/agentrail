import { createHash } from "node:crypto";
import { scanForSecrets } from "./secret-scan";

const GITHUB_API = "https://api.github.com";
const TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 12_288;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REPO = /^([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})$/;
const TOKEN = /^[A-Za-z0-9_.-]{1,8192}$/;
const CONTROL_OR_BIDI = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/u;

export type GithubDependencyBuilderCommentResult =
  | { kind: "published"; commentId: string; commentUrl: string; bodySha256: string }
  | { kind: "known_failure"; reason: "invalid_input" | "github_rejected" }
  | { kind: "unknown"; reason: "github_unavailable" | "ambiguous_response" };

function valid(input: unknown): input is { token: string; repo: string; prNumber: number; body: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== 4 || typeof value.token !== "string" || !TOKEN.test(value.token)
    || typeof value.repo !== "string" || !REPO.test(value.repo)
    || typeof value.prNumber !== "number" || !Number.isSafeInteger(value.prNumber) || value.prNumber <= 0
    || typeof value.body !== "string" || Buffer.byteLength(value.body, "utf8") === 0
    || Buffer.byteLength(value.body, "utf8") > MAX_BODY_BYTES || CONTROL_OR_BIDI.test(value.body)
    || !scanForSecrets(value.body).clean) return false;
  const mentions = value.body.match(/@[A-Za-z0-9_-]+/gu) ?? [];
  return mentions.length === 1 && mentions[0] === "@claude" && value.body.split("@").length === 2;
}

async function boundedJson(response: Response, controller: AbortController): Promise<unknown | null> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    void response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  let rejectAbort!: (reason?: unknown) => void;
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
    rejectAbort(new Error("GitHub dependency handoff response timed out"));
  };
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await Promise.race([reader.read(), aborted]);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    if (controller.signal.aborted) void reader.cancel().catch(() => undefined);
    return null;
  } finally {
    controller.signal.removeEventListener("abort", onAbort);
  }
}

/** One write, exact 201 receipt, no retry and no raw response/token projection. */
export async function postGithubDependencyBuilderComment(
  input: { token: string; repo: string; prNumber: number; body: string },
): Promise<GithubDependencyBuilderCommentResult> {
  if (!valid(input)) return { kind: "known_failure", reason: "invalid_input" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(`${GITHUB_API}/repos/${input.repo}/issues/${input.prNumber}/comments`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "agentrail-console",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ body: input.body }),
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      return { kind: "unknown", reason: "github_unavailable" };
    }
    if (response.status !== 201) {
      void response.body?.cancel().catch(() => undefined);
      return response.status >= 400 && response.status < 500
        ? { kind: "known_failure", reason: "github_rejected" }
        : { kind: "unknown", reason: "github_unavailable" };
    }
    const body = await boundedJson(response, controller);
    const receipt = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
    if (!receipt || typeof receipt.id !== "number" || !Number.isSafeInteger(receipt.id) || receipt.id <= 0
      || receipt.body !== input.body
      || receipt.issue_url !== `${GITHUB_API}/repos/${input.repo}/issues/${input.prNumber}`) {
      return { kind: "unknown", reason: "ambiguous_response" };
    }
    return {
      kind: "published",
      commentId: String(receipt.id),
      commentUrl: `https://github.com/${input.repo}/pull/${input.prNumber}#issuecomment-${receipt.id}`,
      bodySha256: createHash("sha256").update(input.body, "utf8").digest("hex"),
    };
  } finally {
    clearTimeout(timer);
  }
}

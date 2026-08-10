/**
 * The only GitHub write primitive for the selected-route correction carrier.
 * It posts ordinary PR timeline issue comments and accepts a receipt only when
 * GitHub returns the exact body on HTTP 201. An uncertain write is deliberately
 * not retryable here: the DB carrier state must hold it for reconciliation.
 */
import { createHash } from "node:crypto";
import { MAX_GITHUB_CORRECTION_ACTIVATION_BYTES } from "@agentrail/db-postgres";
import { scanForSecrets } from "./secret-scan";

const GITHUB_API = "https://api.github.com";
const GITHUB_FETCH_TIMEOUT_MS = 8_000;
const MAX_COMMENT_BYTES = MAX_GITHUB_CORRECTION_ACTIVATION_BYTES;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REPO = /^([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})$/;
const TOKEN = /^[A-Za-z0-9_.-]{1,8192}$/;
const CONTROL_OR_BIDI = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/u;
const URL_LIKE = /\b(?:[a-z][a-z0-9+.-]{1,31}:\/\/|www\.|mailto:)|\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|app|ai|co|uk|test)\b/iu;

export type GithubCorrectionCarrierCommentInput = {
  token: string;
  repo: string;
  prNumber: number;
  kind: "finding" | "activation";
  body: string;
};

export type GithubCorrectionCarrierCommentResult =
  | { kind: "published"; commentId: string; commentUrl: string; bodySha256: string }
  | { kind: "known_failure"; reason: "invalid_input" | "github_rejected" }
  | { kind: "unknown"; reason: "github_unavailable" | "ambiguous_response" };

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function validateDbIssuedGithubCorrectionActivationBody(input: {
  body: string;
  recipient: "codex" | "claude";
  packetBundleBase64url: string;
  packetBundleSha256: string;
}): boolean {
  if (
    typeof input.body !== "string" || Buffer.byteLength(input.body, "utf8") === 0 ||
    Buffer.byteLength(input.body, "utf8") > MAX_COMMENT_BYTES ||
    typeof input.packetBundleBase64url !== "string" ||
    input.packetBundleBase64url.length > MAX_COMMENT_BYTES ||
    !/^[A-Za-z0-9_-]+$/u.test(input.packetBundleBase64url) ||
    typeof input.packetBundleSha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(input.packetBundleSha256) ||
    CONTROL_OR_BIDI.test(input.body) || URL_LIKE.test(input.body) || !scanForSecrets(input.body).clean
  ) return false;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(input.packetBundleBase64url, "base64url");
  } catch {
    return false;
  }
  if (
    decoded.length === 0 || decoded.length > MAX_COMMENT_BYTES ||
    decoded.toString("base64url") !== input.packetBundleBase64url ||
    createHash("sha256").update(decoded).digest("hex") !== input.packetBundleSha256.toLowerCase()
  ) return false;
  const mentions = input.body.match(/@[A-Za-z0-9_-]+/gu) ?? [];
  return mentions.length === 1 && mentions[0] === `@${input.recipient}`
    && input.body.split("@").length === 2
    && input.body.split(input.packetBundleBase64url).length === 2
    && input.body.split(input.packetBundleSha256.toLowerCase()).length === 2;
}

function inputIsValid(value: unknown): value is GithubCorrectionCarrierCommentInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 5 ||
    typeof input.token !== "string" || !TOKEN.test(input.token) ||
    typeof input.repo !== "string" || !REPO.test(input.repo) ||
    typeof input.prNumber !== "number" || !Number.isSafeInteger(input.prNumber) || input.prNumber <= 0 ||
    (input.kind !== "finding" && input.kind !== "activation") ||
    typeof input.body !== "string" || input.body.length === 0 ||
    Buffer.byteLength(input.body, "utf8") > MAX_COMMENT_BYTES ||
    CONTROL_OR_BIDI.test(input.body) || URL_LIKE.test(input.body) || !scanForSecrets(input.body).clean
  ) return false;
  const mentions = input.body.match(/@[A-Za-z0-9_-]+/gu) ?? [];
  return input.kind === "finding"
    ? !input.body.includes("@")
    : mentions.length === 1 && (mentions[0] === "@codex" || mentions[0] === "@claude")
      && input.body.split("@").length === 2;
}

async function readBoundedJson(
  response: Response,
  controller: AbortController
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_RESPONSE_BYTES)) {
    void response.body?.cancel().catch(() => undefined);
    return { ok: false };
  }
  if (!response.body) return { ok: false };
  const reader = response.body.getReader();
  let rejectAbort!: (reason?: unknown) => void;
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
    rejectAbort(new Error("GitHub comment response timed out"));
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
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { ok: false };
  } finally {
    controller.signal.removeEventListener("abort", onAbort);
  }
}

function isExactReceipt(value: unknown, input: GithubCorrectionCarrierCommentInput): value is {
  id: number;
  body: string;
  issue_url: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const id = body.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || body.body !== input.body) return false;
  const issueUrl = `${GITHUB_API}/repos/${input.repo}/issues/${input.prNumber}`;
  return body.issue_url === issueUrl;
}

/**
 * Posts exactly one server-rendered timeline comment. It never returns the
 * token or raw GitHub body and never retries an outcome that could have
 * created a comment without yielding a trustworthy receipt.
 */
export async function postGithubCorrectionCarrierComment(
  input: GithubCorrectionCarrierCommentInput
): Promise<GithubCorrectionCarrierCommentResult> {
  if (!inputIsValid(input)) return { kind: "known_failure", reason: "invalid_input" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
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
    const parsed = await readBoundedJson(response, controller);
    if (!parsed.ok || !isExactReceipt(parsed.value, input)) {
      return { kind: "unknown", reason: "ambiguous_response" };
    }
    return {
      kind: "published",
      commentId: String(parsed.value.id),
      commentUrl: `https://github.com/${input.repo}/pull/${input.prNumber}#issuecomment-${parsed.value.id}`,
      bodySha256: sha256(input.body),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Narrow GitHub Actions OIDC verifier for the Claude correction acknowledgement
 * callback. It accepts only GitHub's fixed issuer/JWKS, RS256, a caller-derived
 * one-time audience, and the closed claim projection needed by Postgres.
 */
import { createHash } from "node:crypto";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from "jose";

export const GITHUB_ACTIONS_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const GITHUB_ACTIONS_OIDC_JWKS =
  "https://token.actions.githubusercontent.com/.well-known/jwks";
export const GITHUB_CLAUDE_ACK_AUDIENCE_PREFIX =
  "agentrail://correction-dispatch/github-claude/ack/v1";
export const MAX_GITHUB_ACTIONS_OIDC_TOKEN_BYTES = 16 * 1024;

const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const SHA = /^[0-9a-f]{40}$/i;
const POSITIVE_DECIMAL = /^[1-9][0-9]{0,39}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?(?:\[bot\])?$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/;

export type GithubClaudeAcknowledgementOidcClaims = {
  issuer: typeof GITHUB_ACTIONS_OIDC_ISSUER;
  audience: string;
  subject: string;
  subjectSha256: string;
  repository: string;
  repositoryId: string;
  repositoryOwner: string;
  repositoryOwnerId: string;
  actor: string;
  actorId: string;
  eventName: "issue_comment";
  ref: string;
  workflowRef: string;
  workflowSha: string;
  jobWorkflowRef: string;
  jobWorkflowSha: string;
  runId: string;
  runAttempt: 1;
  checkRunId: string;
  jtiSha256: string;
  issuedAt: number;
  notBefore: number;
  expiresAt: number;
};

export type GithubActionsOidcVerificationResult =
  | { ok: true; claims: GithubClaudeAcknowledgementOidcClaims }
  | { ok: false; reason: "invalid_token" };

export type GithubActionsJwtVerifier = (
  token: string,
  audience: string
) => Promise<JWTPayload>;

const remoteJwks = createRemoteJWKSet(new URL(GITHUB_ACTIONS_OIDC_JWKS), {
  timeoutDuration: 5_000,
  cooldownDuration: 30_000,
  cacheMaxAge: 10 * 60_000,
});

export function createGithubActionsJwtVerifier(
  getKey: JWTVerifyGetKey
): GithubActionsJwtVerifier {
  return async (token: string, audience: string): Promise<JWTPayload> => {
    const verified = await jwtVerify(token, getKey, {
      algorithms: ["RS256"],
      issuer: GITHUB_ACTIONS_OIDC_ISSUER,
      audience,
      requiredClaims: ["sub", "jti", "iat", "nbf", "exp"],
      maxTokenAge: "5m",
      clockTolerance: 30,
    });
    return verified.payload;
  };
}

const verifyWithGithubJwks = createGithubActionsJwtVerifier(remoteJwks);

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function positiveDecimal(value: unknown): string | null {
  return typeof value === "string" && POSITIVE_DECIMAL.test(value) ? value : null;
}

function safeText(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length >= 1 && value.length <= max
    && SAFE_TEXT.test(value)
    ? value
    : null;
}

function isExactDefaultRepositoryRefSubject(input: {
  subject: string;
  repository: string;
  repositoryId: string;
  repositoryOwner: string;
  repositoryOwnerId: string;
  ref: string;
}): boolean {
  const repositoryName = input.repository.split("/")[1];
  if (!repositoryName || input.repository.split("/")[0] !== input.repositoryOwner) return false;
  return input.subject === `repo:${input.repository}:ref:${input.ref}`
    || input.subject === `repo:${input.repositoryOwner}@${input.repositoryOwnerId}/${repositoryName}@${input.repositoryId}:ref:${input.ref}`;
}

/**
 * The workflow requests a token audience bound to the exact activation
 * comment and first run attempt. The callback recomputes it before verifying
 * the JWT, so a token minted for another activation cannot be replayed here.
 */
export function githubClaudeAcknowledgementAudience(input: {
  activationCommentId: string;
  runId: string;
  runAttempt: number;
}): string | null {
  if (!positiveDecimal(input.activationCommentId)
    || !positiveDecimal(input.runId)
    || input.runAttempt !== 1) return null;
  const binding = [
    "github_claude_ack",
    "1",
    input.activationCommentId,
    input.runId,
    String(input.runAttempt),
  ].join(":");
  return `${GITHUB_CLAUDE_ACK_AUDIENCE_PREFIX}/${sha256(binding)}`;
}

/**
 * Verifies and closes the OIDC claim surface. It does not decide whether the
 * workflow, route, activation, or head is authoritative; Postgres compares
 * this signed projection with the server-owned acknowledgement profile.
 */
export async function verifyGithubClaudeAcknowledgementOidcToken(
  input: { token: string; audience: string },
  verifyJwt: GithubActionsJwtVerifier = verifyWithGithubJwks
): Promise<GithubActionsOidcVerificationResult> {
  if (typeof input.token !== "string"
    || Buffer.byteLength(input.token, "utf8") > MAX_GITHUB_ACTIONS_OIDC_TOKEN_BYTES
    || !JWT.test(input.token)
    || typeof input.audience !== "string"
    || !input.audience.startsWith(`${GITHUB_CLAUDE_ACK_AUDIENCE_PREFIX}/`)
    || input.audience.length !== GITHUB_CLAUDE_ACK_AUDIENCE_PREFIX.length + 1 + 64) {
    return { ok: false, reason: "invalid_token" };
  }

  try {
    const payload = await verifyJwt(input.token, input.audience);
    const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (payload.iss !== GITHUB_ACTIONS_OIDC_ISSUER
      || audience.length !== 1 || audience[0] !== input.audience
      || payload.event_name !== "issue_comment") {
      return { ok: false, reason: "invalid_token" };
    }

    const subject = safeText(payload.sub, 512);
    const repository = safeText(payload.repository, 201);
    const repositoryId = positiveDecimal(payload.repository_id);
    const repositoryOwner = safeText(payload.repository_owner, 100);
    const repositoryOwnerId = positiveDecimal(payload.repository_owner_id);
    const actor = safeText(payload.actor, 106);
    const actorId = positiveDecimal(payload.actor_id);
    const ref = safeText(payload.ref, 512);
    const workflowRef = safeText(payload.workflow_ref, 1024);
    const workflowSha = safeText(payload.workflow_sha, 40);
    const jobWorkflowRef = safeText(payload.job_workflow_ref, 1024);
    const jobWorkflowSha = safeText(payload.job_workflow_sha, 40);
    const runId = positiveDecimal(payload.run_id);
    const runAttempt = payload.run_attempt === "1" || payload.run_attempt === 1 ? 1 : null;
    const checkRunId = positiveDecimal(payload.check_run_id);
    const jti = safeText(payload.jti, 256);
    const issuedAt = Number.isSafeInteger(payload.iat) && (payload.iat ?? 0) > 0
      ? payload.iat as number : null;
    const notBefore = Number.isSafeInteger(payload.nbf) && (payload.nbf ?? 0) > 0
      ? payload.nbf as number : null;
    const expiresAt = Number.isSafeInteger(payload.exp) && (payload.exp ?? 0) > 0
      ? payload.exp as number : null;

    if (!subject || !repository || !REPOSITORY.test(repository)
      || repository.split("/").some((segment) => segment === "." || segment === "..")
      || !repositoryId || !repositoryOwner || !LOGIN.test(repositoryOwner)
      || !repositoryOwnerId || !actor || !LOGIN.test(actor) || !actorId
      || !ref || !ref.startsWith("refs/heads/")
      || !workflowRef || !workflowSha || !SHA.test(workflowSha)
      || !jobWorkflowRef || !jobWorkflowSha || !SHA.test(jobWorkflowSha)
      || !runId || runAttempt !== 1 || !checkRunId || !jti
      || !issuedAt || !notBefore || !expiresAt
      || notBefore > issuedAt || expiresAt <= issuedAt
      || !isExactDefaultRepositoryRefSubject({
        subject, repository, repositoryId, repositoryOwner, repositoryOwnerId, ref,
      })) {
      return { ok: false, reason: "invalid_token" };
    }

    return {
      ok: true,
      claims: {
        issuer: GITHUB_ACTIONS_OIDC_ISSUER,
        audience: input.audience,
        subject,
        subjectSha256: sha256(subject),
        repository,
        repositoryId,
        repositoryOwner,
        repositoryOwnerId,
        actor,
        actorId,
        eventName: "issue_comment",
        ref,
        workflowRef,
        workflowSha: workflowSha.toLowerCase(),
        jobWorkflowRef,
        jobWorkflowSha: jobWorkflowSha.toLowerCase(),
        runId,
        runAttempt: 1,
        checkRunId,
        jtiSha256: sha256(jti),
        issuedAt,
        notBefore,
        expiresAt,
      },
    };
  } catch {
    return { ok: false, reason: "invalid_token" };
  }
}

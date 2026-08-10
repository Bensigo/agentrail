import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import {
  GITHUB_ACTIONS_OIDC_ISSUER,
  GITHUB_ACTIONS_OIDC_JWKS,
  createGithubActionsJwtVerifier,
  githubClaudeAcknowledgementAudience,
  verifyGithubClaudeAcknowledgementOidcToken,
} from "./github-actions-oidc";

const COMMENT_ID = "99112233";
const RUN_ID = "88776655";
const AUDIENCE = githubClaudeAcknowledgementAudience({
  activationCommentId: COMMENT_ID,
  runId: RUN_ID,
  runAttempt: 1,
})!;

const baseClaims = {
  repository: "Bensigo/example",
  repository_id: "12345",
  repository_owner: "Bensigo",
  repository_owner_id: "67890",
  actor: "jace[bot]",
  actor_id: "424242",
  event_name: "issue_comment",
  ref: "refs/heads/main",
  workflow_ref: "Bensigo/example/.github/workflows/agentrail.yml@refs/heads/main",
  workflow_sha: "a".repeat(40),
  job_workflow_ref:
    "Bensigo/agentrail/.github/workflows/github-claude-correction-ack.yml@refs/heads/main",
  job_workflow_sha: "b".repeat(40),
  run_id: RUN_ID,
  run_attempt: "1",
  check_run_id: "123456789",
};

let privateKey: CryptoKey;
let badPrivateKey: CryptoKey;
let verifier: ReturnType<typeof createGithubActionsJwtVerifier>;

async function token(input: {
  claims?: Record<string, unknown>;
  issuer?: string;
  audience?: string;
  issuedAt?: number;
  expiresAt?: number;
  subject?: string;
  key?: CryptoKey;
} = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...baseClaims, ...input.claims })
    .setProtectedHeader({ alg: "RS256", kid: "agentrail-test" })
    .setIssuer(input.issuer ?? GITHUB_ACTIONS_OIDC_ISSUER)
    .setAudience(input.audience ?? AUDIENCE)
    .setSubject(input.subject ?? "repo:Bensigo/example:ref:refs/heads/main")
    .setJti("9d726c8e-a11d-4b82-bf76-2f73bad65e89")
    .setIssuedAt(input.issuedAt ?? now)
    .setNotBefore((input.issuedAt ?? now) - 1)
    .setExpirationTime(input.expiresAt ?? now + 300)
    .sign(input.key ?? privateKey);
}

beforeAll(async () => {
  const primary = await generateKeyPair("RS256");
  const bad = await generateKeyPair("RS256");
  privateKey = primary.privateKey as CryptoKey;
  badPrivateKey = bad.privateKey as CryptoKey;
  verifier = createGithubActionsJwtVerifier(async () => primary.publicKey);
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("GitHub Claude acknowledgement OIDC", () => {
  it("derives one activation- and run-bound audience", () => {
    expect(AUDIENCE).toMatch(
      /^agentrail:\/\/correction-dispatch\/github-claude\/ack\/v1\/[0-9a-f]{64}$/
    );
    expect(githubClaudeAcknowledgementAudience({
      activationCommentId: COMMENT_ID,
      runId: `${Number(RUN_ID) + 1}`,
      runAttempt: 1,
    })).not.toBe(AUDIENCE);
    expect(githubClaudeAcknowledgementAudience({
      activationCommentId: COMMENT_ID,
      runId: RUN_ID,
      runAttempt: 2,
    })).toBeNull();
  });

  it("verifies the fixed issuer/JWKS/algorithm and returns only bounded claims", async () => {
    const result = await verifyGithubClaudeAcknowledgementOidcToken({
      token: await token(),
      audience: AUDIENCE,
    }, verifier);
    expect(result).toEqual({
      ok: true,
      claims: {
        issuer: GITHUB_ACTIONS_OIDC_ISSUER,
        audience: AUDIENCE,
        subject: "repo:Bensigo/example:ref:refs/heads/main",
        subjectSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        repository: "Bensigo/example",
        repositoryId: "12345",
        repositoryOwner: "Bensigo",
        repositoryOwnerId: "67890",
        actor: "jace[bot]",
        actorId: "424242",
        eventName: "issue_comment",
        ref: "refs/heads/main",
        workflowRef: baseClaims.workflow_ref,
        workflowSha: "a".repeat(40),
        jobWorkflowRef: baseClaims.job_workflow_ref,
        jobWorkflowSha: "b".repeat(40),
        runId: RUN_ID,
        runAttempt: 1,
        checkRunId: "123456789",
        jtiSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        issuedAt: expect.any(Number),
        notBefore: expect.any(Number),
        expiresAt: expect.any(Number),
      },
    });
    expect(GITHUB_ACTIONS_OIDC_JWKS)
      .toBe("https://token.actions.githubusercontent.com/.well-known/jwks");
  });

  it("accepts GitHub's immutable default repository/ref subject", async () => {
    const subject = "repo:Bensigo@67890/example@12345:ref:refs/heads/main";
    await expect(verifyGithubClaudeAcknowledgementOidcToken({
      token: await token({ subject }),
      audience: AUDIENCE,
    }, verifier)).resolves.toMatchObject({
      ok: true,
      claims: {
        subject,
        repositoryId: "12345",
        repositoryOwnerId: "67890",
        ref: "refs/heads/main",
      },
    });
  });

  it.each([
    ["bad signature", () => token({ key: badPrivateKey })],
    ["wrong issuer", () => token({ issuer: "https://example.invalid" })],
    ["wrong audience", () => token({ audience: `${AUDIENCE}0` })],
    ["expired", () => token({ issuedAt: 1, expiresAt: 2 })],
    ["wrong event", () => token({ claims: { event_name: "workflow_run" } })],
    ["rerun", () => token({ claims: { run_attempt: "2" } })],
    ["missing job workflow SHA", () => token({ claims: { job_workflow_sha: undefined } })],
    ["noncanonical repository id", () => token({ claims: { repository_id: "001" } })],
    ["unsafe actor", () => token({ claims: { actor: "jace\n[bot]" } })],
    ["immutable subject with wrong owner id", () => token({
      subject: "repo:Bensigo@67891/example@12345:ref:refs/heads/main",
    })],
    ["immutable subject with wrong repository id", () => token({
      subject: "repo:Bensigo@67890/example@12346:ref:refs/heads/main",
    })],
    ["default subject with wrong ref", () => token({
      subject: "repo:Bensigo/example:ref:refs/heads/other",
    })],
    ["customized subject template", () => token({
      subject: "repo:Bensigo/example:environment:production",
    })],
  ])("rejects %s without leaking verification detail", async (_name, makeToken) => {
    await expect(verifyGithubClaudeAcknowledgementOidcToken({
      token: await makeToken(),
      audience: AUDIENCE,
    }, verifier)).resolves.toEqual({ ok: false, reason: "invalid_token" });
  });

  it("rejects malformed and oversized tokens before JWKS work", async () => {
    const neverVerify = vi.fn(verifier);
    await expect(verifyGithubClaudeAcknowledgementOidcToken({
      token: "not-a-jwt",
      audience: AUDIENCE,
    }, neverVerify)).resolves.toEqual({ ok: false, reason: "invalid_token" });
    await expect(verifyGithubClaudeAcknowledgementOidcToken({
      token: `${"a".repeat(17_000)}.b.c`,
      audience: AUDIENCE,
    }, neverVerify)).resolves.toEqual({ ok: false, reason: "invalid_token" });
    expect(neverVerify).not.toHaveBeenCalled();
  });
});

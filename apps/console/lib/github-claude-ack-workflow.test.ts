import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const WORKFLOW = new URL(
  "../../../.github/workflows/github-claude-correction-ack.yml",
  import.meta.url
);
const CLAUDE_ACTION_SHA = "6b082c41935b4c8a3b8b0ef85ba4ba4d9eeb8975";

describe("trusted GitHub Claude acknowledgement workflow", () => {
  it("pins the selected action and admits only the exact Jace bot trigger", async () => {
    const source = await readFile(WORKFLOW, "utf8");
    expect(source).toContain(`anthropics/claude-code-action@${CLAUDE_ACTION_SHA}`);
    expect(source).not.toMatch(/anthropics\/claude-code-action@(v|main|master)/);
    expect(source).toContain("github.event.comment.user.login == 'jace[bot]'");
    expect(source).toMatch(/allowed_bots:\s+jace\[bot\]/);
    expect(source).not.toMatch(/allowed_bots:\s+["']?\*/);
    expect(source).toContain("contains(github.event.comment.body, '@claude')");
    expect(source).toContain("contains(github.event.comment.body, '- Dispatch ID:')");
  });

  it("mints OIDC only in a fresh success-gated job and never checks out source there", async () => {
    const source = await readFile(WORKFLOW, "utf8");
    const acknowledgementJob = source.slice(source.indexOf("  acknowledge:"));
    expect(acknowledgementJob).toContain("needs: claude");
    expect(acknowledgementJob).toContain("needs.claude.outputs.conclusion == 'success'");
    expect(acknowledgementJob).toContain("needs.claude.outputs.session_id != ''");
    expect(acknowledgementJob).toMatch(/id-token:\s+write/);
    expect(acknowledgementJob).not.toContain("actions/checkout@");
    expect(acknowledgementJob).not.toContain("anthropics/claude-code-action@");
    expect(source.slice(0, source.indexOf("  acknowledge:"))).not.toMatch(/id-token:\s+write/);
  });

  it("binds the first run attempt and posts only to the fixed AgentRail callback path", async () => {
    const source = await readFile(WORKFLOW, "utf8");
    expect(source).toContain('runAttempt !== "1"');
    expect(source).toMatch(
      /"github_claude_ack",\s*"1",\s*activationCommentId,\s*runId,\s*runAttempt,?/
    );
    expect(source).toContain(
      "agentrail://correction-dispatch/github-claude/ack/v1/${sha256(audienceBinding)}"
    );
    expect(source).toContain(
      'callback.pathname !== "/api/v1/webhooks/github-actions/claude-ack"'
    );
    expect(source).toContain('["heyjace.com", "www.heyjace.com"]');
    expect(source).toContain("activationBodySha256: sha256(required(\"ACTIVATION_COMMENT_BODY\"))");
    expect(source).toContain("sessionId: required(\"CLAUDE_SESSION_ID\")");
    expect(source).not.toContain("console.log");
  });
});

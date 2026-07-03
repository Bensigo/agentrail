// Live approval round-trip harness for Jace (AC1 + AC2).
//
// This drives a running Eve sidecar over HTTP — it is a real driver, not a mock.
// It runs the approval flow TWICE:
//   1. APPROVING  → expect a real create_issue result (an issue reference/URL).
//   2. REJECTING  → expect NO issue created; the conversation continues.
//
// How to run:
//   1. In one shell, start the sidecar:   npm run dev        (runs `eve dev` on 127.0.0.1:2000)
//   2. In another shell:                  node scripts/needs-approval-roundtrip.mjs
//
// Environment:
//   EVE_HOST            base URL of the running sidecar (default http://127.0.0.1:2000)
//   JACE_TARGET_REPO    owner/repo the created issue lands in (used by the create_issue tool)
//   VERCEL_OIDC_TOKEN or AI_GATEWAY_API_KEY   AI Gateway auth for the string model id
//   GITHUB_OAUTH_TOKEN or GITHUB_TOKEN        auth for the CLI's github connector
//   JACE_AGENTRAIL_BIN  optional override for the `agentrail` binary

import { Client } from "eve/client";

const EVE_HOST = process.env.EVE_HOST || "http://127.0.0.1:2000";

const PROMPT =
  "Create an AgentRail issue titled 'Add a health endpoint to the runner' " +
  "with acceptance criterion 'AC1: GET /health returns 200 with an ok body'. " +
  "Parent is the runner epic. Propose it and wait for my approval.";

/**
 * Open a session, send the prompt, and let it run to the create_issue approval
 * boundary; then respond with the chosen option (approve or reject) and await
 * the final result.
 *
 * Verified against installed eve@0.19.0: a `ClientSession` comes from
 * `client.session()`, `session.send(input)` returns a `MessageResponse`, and
 * `response.result()` resolves to a `MessageResult` — at a human-in-the-loop
 * boundary it resolves with `status: "waiting"` and the pending approvals in
 * `inputRequests`. Resuming is another `send({ inputResponses })` → `result()`.
 *
 * @param {Client} client
 * @param {"approve"|"reject"} decision
 * @returns {Promise<{ decision: string, request: object, result: any }>}
 */
async function runArm(client, decision) {
  const session = client.session();

  // Run the first turn to completion — it should pause for approval.
  const first = await (await session.send({ message: PROMPT })).result();
  if (first.status !== "waiting") {
    throw new Error(
      `[${decision}] expected the turn to pause for approval (status "waiting") ` +
        `but got status "${first.status}"; create_issue must be human-gated`,
    );
  }

  // Find the pending approval for the create_issue tool call.
  const request = (first.inputRequests ?? []).find(
    (r) => r?.action?.toolName === "create_issue",
  );
  if (!request || !Array.isArray(request.options)) {
    throw new Error(
      `[${decision}] never received a create_issue approval request with options; ` +
        `got inputRequests: ${JSON.stringify(first.inputRequests)}`,
    );
  }

  // eve@0.19.0 confirmation approvals carry two options with ids
  // "approve" / "deny". Match by id, with a label fallback for safety.
  const wants = (o) => {
    const id = String(o.id ?? "").toLowerCase();
    const label = String(o.label ?? "").toLowerCase();
    return decision === "approve"
      ? id === "approve" || label.includes("approve") || label.includes("allow")
      : id === "deny" || label.includes("deny") || label.includes("reject");
  };
  const pick =
    request.options.find(wants) ??
    request.options[decision === "approve" ? 0 : request.options.length - 1];

  // Resume the paused turn with the chosen option and await the final result.
  const result = await (
    await session.send({
      inputResponses: [{ requestId: request.requestId, optionId: pick.id }],
    })
  ).result();
  return { decision, request, result };
}

function extractIssueRef(result) {
  // The create_issue tool returns { repo, number, url, label }. Scan the
  // result payload (shape may be nested by Eve) for a github issue url/number.
  const json = JSON.stringify(result ?? {});
  const urlMatch = json.match(/https?:\/\/[^\s"]*\/issues\/\d+/);
  const numberMatch = json.match(/"number"\s*:\s*(\d+)/);
  if (urlMatch) return urlMatch[0];
  if (numberMatch) return `#${numberMatch[1]}`;
  return null;
}

async function main() {
  const client = new Client({ host: EVE_HOST });
  let failures = 0;

  // Arm 1: APPROVE → expect a real issue reference.
  try {
    const { result } = await runArm(client, "approve");
    const ref = extractIssueRef(result);
    if (ref) {
      console.log(`PASS approve: create_issue ran, issue created → ${ref}`);
    } else {
      failures++;
      console.log(
        `FAIL approve: expected a created issue reference but found none in result: ${JSON.stringify(result)}`,
      );
    }
  } catch (err) {
    failures++;
    console.log(`FAIL approve: ${err.message}`);
  }

  // Arm 2: REJECT → expect NO issue created; conversation continues.
  try {
    const { result } = await runArm(client, "reject");
    const ref = extractIssueRef(result);
    if (!ref) {
      console.log(
        "PASS reject: no issue created; conversation continued without a create_issue result",
      );
    } else {
      failures++;
      console.log(
        `FAIL reject: an issue was created despite rejection → ${ref}`,
      );
    }
  } catch (err) {
    failures++;
    console.log(`FAIL reject: ${err.message}`);
  }

  if (failures > 0) {
    console.log(`\nRESULT: ${failures} arm(s) failed`);
    process.exit(1);
  }
  console.log("\nRESULT: both arms passed");
}

main().catch((err) => {
  console.error(`FAIL: harness error: ${err.stack ?? err.message ?? err}`);
  process.exit(1);
});

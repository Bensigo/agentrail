// Spike #1030 — needsApproval round-trip against a running Eve host.
//
// Proves AC2: a `needsApproval: always()` tool parks the turn on an approval
// request, and BOTH the approve and the reject paths resume correctly.
//
// Prereq: `eve dev` running. Note: `eve dev` in eve@0.19.0 listens on
// http://127.0.0.1:2000/ (NOT 3000 as the docs imply). Then:
//   node scripts/needs-approval-roundtrip.mjs
// Override with EVE_HOST=http://127.0.0.1:<port> if your server differs.
//
// It runs the coordinator twice — once approving the create_issue call, once
// rejecting it — and prints what came back each time. We derive the option ids
// from request.options rather than hardcoding "approve"/"reject", so the script
// stays honest about the real approval shape the server emits.

import { Client } from "eve/client";

const HOST = process.env.EVE_HOST ?? "http://127.0.0.1:2000";
const PROMPT =
  "File an issue under epic #1024 to add a health check to the coordinator's session endpoint.";

const client = new Client({ host: HOST });

/** Pick the option id that means "approve", else the first option. */
function approveOptionId(request) {
  const opts = request.options ?? [];
  const approve = opts.find((o) => /approve|allow|yes|confirm/i.test(o.id ?? o.label ?? ""));
  return (approve ?? opts[0])?.id;
}

/** Pick the option id that means "reject", else the last option. */
function rejectOptionId(request) {
  const opts = request.options ?? [];
  const reject = opts.find((o) => /reject|deny|no|cancel|decline/i.test(o.id ?? o.label ?? ""));
  return (reject ?? opts[opts.length - 1])?.id;
}

async function runOnce(decision) {
  const session = client.session();
  const response = await session.send(PROMPT);

  let pending = [];
  for await (const event of response) {
    if (event.type === "input.requested") {
      pending = event.data.requests;
    }
  }

  if (pending.length === 0) {
    console.log(`[${decision}] no approval was requested — did the model call create_issue?`);
    return;
  }

  const req = pending[0];
  console.log(`[${decision}] approval requested:`);
  console.log(`  requestId: ${req.requestId}`);
  console.log(`  prompt:    ${req.prompt ?? "(none)"}`);
  console.log(`  options:   ${JSON.stringify((req.options ?? []).map((o) => o.id))}`);

  const optionId =
    decision === "approve" ? approveOptionId(req) : rejectOptionId(req);
  console.log(`  answering with optionId=${optionId}`);

  const resumed = await session.send({
    inputResponses: pending.map((r) => ({
      requestId: r.requestId,
      optionId: decision === "approve" ? approveOptionId(r) : rejectOptionId(r),
    })),
  });

  const result = await resumed.result();
  console.log(`[${decision}] resumed result:`, JSON.stringify(result, null, 2));
  console.log("");
}

console.log(`Eve host: ${HOST}\n`);
console.log("=== APPROVE path ===");
await runOnce("approve");
console.log("=== REJECT path ===");
await runOnce("reject");
console.log("Done. Both approve and reject paths exercised.");

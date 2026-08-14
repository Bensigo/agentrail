import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizeHostedInbound } from "../agent/lib/hosted_inbound_auth.core.mjs";

function headers(value) {
  return { get: (name) => name.toLowerCase() === "authorization" ? value : null };
}

test("hosted inbound requires the independent Console service token", () => {
  const env = { JACE_HOSTED_INBOUND_TOKEN: "shared-hop-secret" };
  assert.equal(authorizeHostedInbound(headers("Bearer shared-hop-secret"), env), true);
  assert.equal(authorizeHostedInbound(headers("Bearer wrong-hop-secret"), env), false);
  assert.equal(authorizeHostedInbound(headers(null), env), false);
  assert.equal(authorizeHostedInbound(headers("Bearer shared-hop-secret"), {}), false);
});

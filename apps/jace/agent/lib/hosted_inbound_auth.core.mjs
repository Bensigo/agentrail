import { timingSafeEqual } from "node:crypto";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Authenticates Console's internal hop to the hosted-inbound door.  The
 * channel still validates its own workspace/task bindings afterwards; this
 * check establishes that the caller is the Console service at all.
 */
export function authorizeHostedInbound(headers, env = {}) {
  const expected = text(env.JACE_HOSTED_INBOUND_TOKEN);
  const header = text(headers?.get?.("authorization"));
  const match = header.match(/^Bearer ([^\s]+)$/u);
  const supplied = match?.[1] ?? "";
  if (!expected || !supplied) return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  return expectedBytes.length === suppliedBytes.length
    && timingSafeEqual(expectedBytes, suppliedBytes);
}

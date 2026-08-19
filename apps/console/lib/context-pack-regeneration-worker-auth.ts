import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";

const WORKER_TOKEN_ENV = "JACE_CONTEXT_PACK_REGENERATION_WORKER_TOKEN";
const CENTRAL_TOKEN_ENV = "JACE_CONSOLE_TOKEN";
const MAX_TOKEN_BYTES = 4096;

function unauthorized(): NextResponse {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/** Dedicated bearer capability for the two opaque regeneration worker doors. */
export function requireContextPackRegenerationWorkerSecret(
  request: NextRequest,
): NextResponse | null {
  const expected = process.env[WORKER_TOKEN_ENV];
  const central = process.env[CENTRAL_TOKEN_ENV];
  if (!expected || expected === central || Buffer.byteLength(expected, "utf8") > MAX_TOKEN_BYTES
    || /[\u0000-\u001f\u007f]/u.test(expected)) return unauthorized();
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return unauthorized();
  const actual = header.slice(7).trim();
  if (!actual || Buffer.byteLength(actual, "utf8") > MAX_TOKEN_BYTES) return unauthorized();
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes)
    ? null
    : unauthorized();
}

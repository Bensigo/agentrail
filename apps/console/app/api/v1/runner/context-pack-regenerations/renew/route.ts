import { NextRequest, NextResponse } from "next/server";
import { renewAcceptanceContextPackRegenerationExecutionLease } from "@agentrail/db-postgres";
import { requireContextPackRegenerationWorkerSecret } from "../../../../../../lib/context-pack-regeneration-worker-auth";
import { readBoundedContextPackRegenerationJson } from "../bounded-json";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function POST(request: NextRequest) {
  const unauthorized = requireContextPackRegenerationWorkerSecret(request);
  if (unauthorized) return unauthorized;
  const body = await readBoundedContextPackRegenerationJson(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid lease renewal" }, { status: 400 });
  }
  const value = body as Record<string, unknown>;
  if (Object.keys(value).length !== 3 || !UUID.test(String(value["executionId"] ?? ""))
    || typeof value["workerId"] !== "string"
    || !/^[A-Za-z0-9_-]{43}$/u.test(String(value["leaseToken"] ?? ""))) {
    return NextResponse.json({ error: "Invalid lease renewal" }, { status: 400 });
  }
  const result = await renewAcceptanceContextPackRegenerationExecutionLease({
    executionId: String(value["executionId"]),
    workerId: value["workerId"],
    leaseToken: String(value["leaseToken"]),
  });
  if (result.kind === "not_owned") {
    return NextResponse.json({ error: "Execution not owned" }, { status: 409 });
  }
  return NextResponse.json({ renewed: { leaseExpiresAt: result.leaseExpiresAt.toISOString() } });
}

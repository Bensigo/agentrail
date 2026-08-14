import { NextRequest, NextResponse } from "next/server";
import { requireJaceConsoleSecret } from "../../../../../../lib/jace-console-auth";
import { executeAcceptanceContextPackRegeneration } from "../../../../../../lib/acceptance-context-pack-regeneration-execution";
import { readBoundedContextPackRegenerationJson } from "../bounded-json";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function POST(request: NextRequest) {
  const unauthorized = requireJaceConsoleSecret(request);
  if (unauthorized) return unauthorized;
  const body = await readBoundedContextPackRegenerationJson(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid execution" }, { status: 400 });
  }
  const value = body as Record<string, unknown>;
  if (Object.keys(value).length !== 3 || !UUID.test(String(value["executionId"] ?? ""))
    || typeof value["workerId"] !== "string"
    || !/^[A-Za-z0-9_-]{43}$/u.test(String(value["leaseToken"] ?? ""))) {
    return NextResponse.json({ error: "Invalid execution" }, { status: 400 });
  }
  const result = await executeAcceptanceContextPackRegeneration({
    executionId: String(value["executionId"]),
    workerId: value["workerId"],
    leaseToken: String(value["leaseToken"]),
  });
  if (result.kind === "not_owned") return NextResponse.json({ error: "Execution not owned" }, { status: 409 });
  return NextResponse.json({
    result: result.kind === "completed"
      ? { kind: "completed", status: result.execution.status }
      : { kind: result.kind },
  });
}

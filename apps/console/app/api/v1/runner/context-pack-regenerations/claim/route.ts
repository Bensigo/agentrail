import { NextRequest, NextResponse } from "next/server";
import { claimAcceptanceContextPackRegenerationExecution } from "@agentrail/db-postgres";
import { requireContextPackRegenerationWorkerSecret } from "../../../../../../lib/context-pack-regeneration-worker-auth";
import { readBoundedContextPackRegenerationJson } from "../bounded-json";

export async function POST(request: NextRequest) {
  const unauthorized = requireContextPackRegenerationWorkerSecret(request);
  if (unauthorized) return unauthorized;
  const body = await readBoundedContextPackRegenerationJson(request);
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).length !== 1
    || typeof (body as Record<string, unknown>)["workerId"] !== "string") {
    return NextResponse.json({ error: "Invalid claim" }, { status: 400 });
  }
  try {
    const claim = await claimAcceptanceContextPackRegenerationExecution({
      workerId: (body as { workerId: string }).workerId,
    });
    return claim ? NextResponse.json({ claim }) : new NextResponse(null, { status: 204 });
  } catch {
    return NextResponse.json({ error: "Invalid claim" }, { status: 400 });
  }
}

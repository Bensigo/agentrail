import { NextRequest, NextResponse } from "next/server";
import { exchangeDeviceCode } from "@agentrail/db-postgres";

/**
 * Poll for the runner token. No auth: the runner is still acquiring its key.
 *
 *   pending  → 202 {error:"authorization_pending"}
 *   expired  → 400 {error:"expired_token"}
 *   denied   → 400 {error:"access_denied"} (unknown / already-consumed)
 *   approved → 200 {token, workspace_id} (raw key returned exactly once)
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    device_code?: string;
  };
  const deviceCode = typeof body.device_code === "string" ? body.device_code : "";
  if (!deviceCode) {
    return NextResponse.json({ error: "access_denied" }, { status: 400 });
  }

  const result = await exchangeDeviceCode(deviceCode);

  switch (result.status) {
    case "pending":
      return NextResponse.json(
        { error: "authorization_pending" },
        { status: 202 }
      );
    case "expired":
      return NextResponse.json({ error: "expired_token" }, { status: 400 });
    case "denied":
      return NextResponse.json({ error: "access_denied" }, { status: 400 });
    case "approved":
      return NextResponse.json({
        token: result.token,
        workspace_id: result.workspaceId,
      });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { startDeviceCode } from "@agentrail/db-postgres";

/**
 * Begin a device-authorization flow for the self-hosted runner. No auth: the
 * runner has no token yet. Returns the device code (the runner polls /token with
 * it), the short user code (the operator types it into /activate), and the poll
 * interval. Matches the OAuth 2.0 device-flow shape the Python CLI expects.
 */
export async function POST(request: NextRequest) {
  const { deviceCode, userCode } = await startDeviceCode();

  const origin = new URL(request.url).origin;

  return NextResponse.json({
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${origin}/activate`,
    interval: 5,
  });
}

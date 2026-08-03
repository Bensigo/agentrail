import { NextRequest, NextResponse } from "next/server";

/** Local-only OAuth token stand-in for the disposable connector smoke test. */
export async function POST(request: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = new URLSearchParams(await request.text());
  if (!body.get("client_id") || !body.get("client_secret")) {
    return NextResponse.json({ error: "invalid_client" }, { status: 401 });
  }
  if (body.get("grant_type") === "authorization_code" && body.get("code") === "codex-smoke-auth-code") {
    return NextResponse.json({
      access_token: "codex-smoke-access-token",
      refresh_token: "codex-smoke-refresh-token",
      expires_in: 3600,
    });
  }
  if (body.get("grant_type") === "refresh_token" && body.get("refresh_token") === "codex-smoke-refresh-token") {
    return NextResponse.json({
      access_token: "codex-smoke-refreshed-access-token",
      refresh_token: "codex-smoke-refresh-token-2",
      expires_in: 3600,
    });
  }
  return NextResponse.json({ error: "invalid_grant" }, { status: 400 });
}

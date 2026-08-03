import { NextRequest, NextResponse } from "next/server";

/** Local-only OAuth consent stand-in for the disposable connector smoke test. */
export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const redirectUri = request.nextUrl.searchParams.get("redirect_uri");
  const state = request.nextUrl.searchParams.get("state");
  const clientId = request.nextUrl.searchParams.get("client_id");
  const challenge = request.nextUrl.searchParams.get("code_challenge");
  if (!redirectUri || !state || !clientId || !challenge) {
    return NextResponse.json({ error: "Missing OAuth parameters" }, { status: 400 });
  }

  const callback = new URL(redirectUri);
  callback.searchParams.set("code", "codex-smoke-auth-code");
  callback.searchParams.set("state", state);
  return NextResponse.redirect(callback);
}

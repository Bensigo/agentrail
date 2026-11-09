import { NextRequest, NextResponse } from "next/server";
import { exchangeLocalLogin } from "@agentrail/db-postgres";

export async function GET(request: NextRequest) {
  const host = request.headers.get("host") || "";
  if (
    process.env.LOCAL_OPERATOR_LOGIN !== "1" ||
    process.env.VERCEL ||
    !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)
  ) {
    return new NextResponse("Not found", { status: 404 });
  }
  const code = request.nextUrl.searchParams.get("code") || "";
  const session = await exchangeLocalLogin(code);
  if (!session)
    return new NextResponse(
      "Local login expired or already used. Run pnpm local:open again.",
      { status: 401 },
    );
  const response = NextResponse.redirect(
    new URL("/dashboard", `http://${host}`),
  );
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "no-referrer");
  response.cookies.set(
    `${process.env.AUTH_COOKIE_PREFIX || "authjs"}.session-token`,
    session.token,
    {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/",
      expires: session.expires,
    },
  );
  return response;
}

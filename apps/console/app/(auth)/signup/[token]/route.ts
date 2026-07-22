import { NextRequest, NextResponse } from "next/server";
import { redeemSignupToken } from "../../../../lib/signup-redeem";
import { sessionCookieName, sessionCookieOptions } from "../../../../lib/session-cookie";

interface Params {
  params: Promise<{ token: string }>;
}

/**
 * GET /signup/[token] — the sign-up magic-link landing page Jace's in-chat
 * link points at (issue #1364, PR ①). A ROUTE HANDLER, not an RSC page like
 * `/connect/[token]`: Next.js only allows `cookies().set()` from a Server
 * Action or Route Handler, never from a plain Server Component render, and
 * this flow — unlike `/connect/[token]`, which delegates entirely to
 * NextAuth's own `signIn("github", ...)` to establish the session — has to
 * set the session cookie itself (see `signup-redeem.ts`'s module comment for
 * why: there is no OAuth round trip here for the framework to hook).
 *
 * ALL the security-relevant logic (atomic single-use consume, server-derived
 * identity, user create-or-reuse, session mint) lives in
 * `signup-redeem.ts::redeemSignupToken` — this handler is a thin translation
 * layer: call it, then turn the result into an HTTP response + (on success)
 * a `Set-Cookie` header. See that module's own doc-comment for the AC3
 * security writeup this route relies on.
 *
 * Both outcomes render 200 with a plain HTML page (no redirect, no distinct
 * error status) — matching `/connect/[token]`'s own posture of never using
 * the HTTP status itself to signal which outcome occurred.
 *
 * `useSecureCookies` mirrors Auth.js's own default derivation
 * (`request.nextUrl.protocol === "https:"`) — see `session-cookie.ts`'s
 * doc-comment for why this is the right signal in a deploy with no
 * `NEXTAUTH_URL`/`AUTH_URL` env set.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const { token } = await params;
  const result = await redeemSignupToken(token);

  if (result.kind === "expired_or_used") {
    return htmlResponse(
      renderPage(
        "Link expired or already used",
        "Ask Jace for a fresh sign-up link in the chat."
      )
    );
  }

  const bodyLine = result.ownerElectCompletionLine
    ? result.ownerElectCompletionLine
    : "Head back to the chat and ask Jace to set up your workspace — it'll pick up right here.";

  const response = htmlResponse(renderPage("You're signed up", bodyLine));

  const useSecureCookies = request.nextUrl.protocol === "https:";
  response.cookies.set(
    sessionCookieName(useSecureCookies),
    result.sessionToken,
    sessionCookieOptions(useSecureCookies, result.sessionExpires)
  );

  return response;
}

function htmlResponse(html: string): NextResponse {
  return new NextResponse(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * Plain inline-style markup — matches `/connect/[token]`'s
 * `ConnectMessage`/success-screen styling posture exactly (no new
 * design-system work for this landing page), just built as a raw HTML
 * string instead of JSX since this is a Route Handler, not an RSC page.
 */
function renderPage(title: string, body: string): string {
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escape(title)}</title>
</head>
<body style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;font-family:system-ui, sans-serif;gap:0.75rem;text-align:center;padding:2rem;">
<h1 style="font-size:1.5rem;">${escape(title)}</h1>
<p style="color:#666;max-width:40ch;">${escape(body)}</p>
</body>
</html>`;
}

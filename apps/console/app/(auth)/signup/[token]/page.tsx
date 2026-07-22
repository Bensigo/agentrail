import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { findChatIdentityBySignupToken } from "@agentrail/db-postgres";
import { redeemSignupToken, buildSignupActionOutcome } from "../../../../lib/signup-redeem";
import { resolveUseSecureCookiesFromHeaders } from "../../../../lib/session-cookie";
import { LIGHT_SURFACE } from "../../../../lib/light-surface";
import { AUTH_MAIN, AUTH_INK_BUTTON, AuthCard, JaceAvatar, BackToJace } from "../../_shell";

interface Props {
  params: Promise<{ token: string }>;
}

/**
 * /signup/[token] — the sign-up magic-link landing page Jace's in-chat link
 * points at (issue #1364, PR ①). An RSC PAGE, not a Route Handler — this is
 * a POST-REVIEW anti-unfurl fix: an earlier version of this file was a
 * Route Handler that called `redeemSignupToken` (the atomic single-use
 * consume) directly on the GET. That is broken in the feature's ACTUAL
 * delivery channel: Telegram (and every other chat platform this will ever
 * ship to — Slack, Discord, iMessage) unfurls a shared link by fetching it
 * SERVER-SIDE to build a preview, before any human clicks it. Browser
 * prefetch, corporate link scanners, and antivirus do the same. Consuming
 * on GET meant the FIRST such automated fetch burned the token — by the
 * time the human actually clicked, the link already read "expired or
 * already used". A single manual `curl GET` in isolation looked like
 * success, which is exactly why this bug survived the first round of tests.
 *
 * The fix mirrors `/connect/[token]/page.tsx`'s own structure exactly: that
 * page's unauthenticated GET only ever renders a "Sign in with GitHub"
 * `<form>` whose Server Action does the actual work (`signIn` triggers the
 * OAuth round trip; `consumeChatIdentityLinkToken` only runs once the human
 * completes it and lands back here) — an unfurl bot never signs in, so it
 * never consumes. This page has no OAuth round trip to gate on (sign-up is
 * passwordless), so it gates on an explicit human form submission instead:
 * GET renders a plain "Finish signing up" button; ONLY that button's Server
 * Action (`finishSignup` below) calls `redeemSignupToken`, the atomic
 * consume. No automated fetch of this URL ever submits a form.
 *
 * The GET render's own `findChatIdentityBySignupToken` call is a
 * NON-CONSUMING read (a nicety, not the security boundary) — see that
 * function's doc-comment in `queries/chat_identities.ts` — purely so a
 * truly dead link shows "expired" immediately rather than a button that
 * would then fail. Its result is NEVER what actually authorizes anything;
 * `finishSignup`'s own atomic consume is the sole authority.
 */
export default async function SignupPage({ params }: Props) {
  const { token } = await params;

  const precheck = await findChatIdentityBySignupToken(token);
  if (!precheck) {
    return (
      <SignupMessage
        title="Link expired or already used"
        body="Ask Jace for a fresh sign-up link in the chat."
      />
    );
  }

  async function finishSignup() {
    "use server";

    // THE atomic, single-use consume (AC3) — see signup-redeem.ts's module
    // comment: this must NEVER be reachable from a bare GET, only from this
    // explicit human button-press Server Action.
    const result = await redeemSignupToken(token);
    const useSecureCookies = await resolveUseSecureCookiesFromHeaders();
    const outcome = buildSignupActionOutcome(result, token, useSecureCookies);

    if (outcome.cookie) {
      const store = await cookies();
      store.set(outcome.cookie.name, outcome.cookie.value, outcome.cookie.options);
    }

    redirect(outcome.redirectTo);
  }

  // Auth-v2 restyle only: the <main> root, the single human-pressed form,
  // and finishSignup's exclusivity are the tested anti-unfurl contract and
  // stay exactly as they were.
  return (
    <main style={LIGHT_SURFACE} className={AUTH_MAIN}>
      <AuthCard>
        <JaceAvatar />
        <h1 className="text-2xl font-bold sm:text-3xl">
          Jace sent you this link to finish signing up
        </h1>
        <p className="max-w-[36ch] text-[var(--gray-11)]">
          Click below to create your account. Jace will pick up right where
          you left off in the chat.
        </p>
        <form action={finishSignup}>
          <button type="submit" className={AUTH_INK_BUTTON}>
            Finish signing up
          </button>
        </form>
      </AuthCard>
    </main>
  );
}

function SignupMessage({ title, body }: { title: string; body: string }) {
  return (
    <main style={LIGHT_SURFACE} className={AUTH_MAIN}>
      <AuthCard>
        <JaceAvatar />
        <h1 className="text-2xl font-bold sm:text-3xl">{title}</h1>
        <p className="max-w-[36ch] text-[var(--gray-11)]">{body}</p>
      </AuthCard>
      <BackToJace />
    </main>
  );
}

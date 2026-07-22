/**
 * Plain-language copy for the branded auth error page (#1294 AC3). NextAuth
 * forwards a small set of error codes as `?error=` when a sign-in fails; this
 * maps each to a title + body a person can actually act on, and falls back to a
 * neutral default for anything unrecognised. Kept as a pure function so the
 * mapping is unit-tested without rendering the page.
 *
 * Voice: the console's — direct, no "Error:" prefix, no codes or jargon in the
 * body, and it reassures that a failed sign-in changed nothing.
 */
export interface AuthErrorContent {
  title: string;
  body: string;
}

/** The codes NextAuth passes to `pages.error` that we speak to by name. */
const KNOWN: Record<string, AuthErrorContent> = {
  // The user declined the GitHub consent screen (or it was cancelled).
  AccessDenied: {
    title: "You didn't finish signing in",
    body: "GitHub didn't get your go-ahead, so we stopped here. Nothing changed on your account — give it another try when you're ready.",
  },
  // Server-side misconfiguration (bad client id/secret, etc.).
  Configuration: {
    title: "Sign-in is having a problem",
    body: "This one's on us — sign-in isn't working right now. Try again in a moment, and tell us if it keeps happening.",
  },
  // GitHub returned an error partway through the OAuth handoff.
  OAuthCallbackError: {
    title: "GitHub couldn't complete sign-in",
    body: "Something interrupted the handoff from GitHub. It's usually temporary, so try again.",
  },
  // Email-link flows (token expired/already used) — mapped for completeness.
  Verification: {
    title: "That sign-in link has expired",
    body: "The link was already used or ran out of time. Start again to get a fresh one.",
  },
};

const DEFAULT: AuthErrorContent = {
  title: "Sign-in didn't work",
  body: "We couldn't sign you in just now. Nothing changed on your account — try again.",
};

export function authErrorCopy(
  code: string | null | undefined
): AuthErrorContent {
  if (code && Object.prototype.hasOwnProperty.call(KNOWN, code)) {
    return KNOWN[code]!;
  }
  return DEFAULT;
}

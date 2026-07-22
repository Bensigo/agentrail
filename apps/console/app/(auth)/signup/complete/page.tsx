import { LIGHT_SURFACE } from "../../../../lib/light-surface";
import { AUTH_MAIN, AuthCard, JaceAvatar, BackToJace } from "../../_shell";

/**
 * /signup/complete — the static, generic landing a successful `/signup/[token]`
 * Server Action redirects to (issue #1364, PR ①). Deliberately carries NO
 * per-request data (no query params, no token, no workspace name) — see
 * `signup-redeem.ts`'s `buildSignupActionOutcome` doc-comment for why:
 * personalizing this page would mean trusting a redirect-time value a
 * crafted URL could also fake (harmless on its own — no session is granted
 * by visiting this page directly — but needless sloppiness this design
 * avoids). The richer, personalized confirmation (workspace ownership,
 * etc.) already went out in-thread via `sendSignupConfirmation`, from
 * `redeemSignupToken` itself, before this page ever rendered.
 */
export default function SignupCompletePage() {
  return (
    <main style={LIGHT_SURFACE} className={AUTH_MAIN}>
      <AuthCard>
        <JaceAvatar />
        <h1 className="text-2xl font-bold sm:text-3xl">You&apos;re signed up</h1>
        <p className="max-w-[36ch] text-[var(--gray-11)]">
          Head back to the chat and ask Jace to set up your workspace —
          it&apos;ll pick up right here.
        </p>
      </AuthCard>
      <BackToJace />
    </main>
  );
}

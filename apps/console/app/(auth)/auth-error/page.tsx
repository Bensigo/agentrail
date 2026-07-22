import Link from "next/link";
import { LIGHT_SURFACE } from "../../../lib/light-surface";
import { authErrorCopy } from "../../../lib/auth-error-copy";
import {
  AUTH_MAIN,
  AUTH_INK_BUTTON,
  AuthCard,
  JaceAvatar,
  BackToJace,
} from "../_shell";

/** /auth-error — where NextAuth sends a denied or failed sign-in (pages.error,
 *  #1294 AC3). Same auth-v2 front-door shell as /login (paper surface, ink
 *  card, lemon press button), so a failure never dumps the visitor on an
 *  unbranded page. Reads the `?error=` code NextAuth forwards and speaks to it
 *  in plain language, then offers a clear way back to sign-in. */
export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const params = await searchParams;
  const raw = params.error;
  const code = Array.isArray(raw) ? raw[0] : raw;
  const { title, body } = authErrorCopy(code);

  return (
    <main style={LIGHT_SURFACE} className={AUTH_MAIN}>
      <AuthCard>
        <JaceAvatar />
        <h1 className="text-2xl font-bold sm:text-3xl">{title}</h1>
        <p className="max-w-[36ch] text-[var(--gray-11)]">{body}</p>
        <Link href="/login" className={AUTH_INK_BUTTON}>
          Try again
        </Link>
      </AuthCard>
      <BackToJace />
    </main>
  );
}

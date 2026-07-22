import { signIn } from "@agentrail/auth";
import { LIGHT_SURFACE } from "../../../lib/light-surface";
import { GithubBrand } from "../../(dashboard)/dashboard/[workspaceId]/connectors/components/brand-icons";
import { AUTH_MAIN, AUTH_INK_BUTTON, AuthCard, JaceAvatar, BackToJace } from "../_shell";

/** /login — the console's front door, in the landing's language (auth-v2):
 *  paper surface, ink card, mono voice, lemon press button. Same server
 *  action as the landing's sign-in seams. */
export default function LoginPage() {
  return (
    <main style={LIGHT_SURFACE} className={AUTH_MAIN}>
      <AuthCard>
        <JaceAvatar />
        <h1 className="text-2xl font-bold sm:text-3xl">
          Sign in to Jace
          <span aria-hidden className="animate-pulse font-mono">
            _
          </span>
        </h1>
        <p className="max-w-[34ch] text-[var(--gray-11)]">
          Connect GitHub and pick up where you left off.
        </p>
        <form
          action={async () => {
            "use server";
            await signIn("github", { redirectTo: "/" });
          }}
        >
          <button type="submit" className={AUTH_INK_BUTTON}>
            <GithubBrand size={18} />
            Sign in with GitHub
          </button>
        </form>
      </AuthCard>
      <BackToJace />
    </main>
  );
}

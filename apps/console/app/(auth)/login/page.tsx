import { signIn } from "@agentrail/auth";
import { LIGHT_SURFACE } from "../../../lib/light-surface";
import { GithubBrand } from "../../(dashboard)/dashboard/[workspaceId]/connectors/components/brand-icons";
import { AUTH_MAIN, AUTH_INK_BUTTON, AuthCard, AgentRailMark, BackToAgentRail } from "../_shell";

/** /login — the console's front door, in the landing's language (auth-v2):
 *  paper surface, ink card, mono voice, lemon press button. Same server
 *  action as the landing's sign-in seams. */
export const dynamic = "force-dynamic";
export default function LoginPage() {
  if (process.env.LOCAL_OPERATOR_LOGIN === "1" && !process.env.VERCEL) {
    return <main style={LIGHT_SURFACE} className={AUTH_MAIN}><AuthCard>
      <h1 className="text-2xl font-bold">Local Console</h1>
      <p>Run <code>pnpm local:open</code> from this checkout to open your local operator session.</p>
      <p className="text-sm text-[var(--gray-09)]">No GitHub OAuth or hosted product account is required.</p>
    </AuthCard></main>;
  }
  return (
    <main style={LIGHT_SURFACE} className={AUTH_MAIN}>
      <AuthCard>
        <AgentRailMark />
        <h1 className="text-2xl font-bold sm:text-3xl">Sign in to AgentRail</h1>
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
      <BackToAgentRail />
    </main>
  );
}

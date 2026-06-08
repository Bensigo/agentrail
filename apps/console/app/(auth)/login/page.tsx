import { signIn } from "@agentrail/auth";
import { Button } from "@agentrail/ui";

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--gray-00)]">
      <div className="w-full max-w-sm rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-6">
        <h1 className="text-xl font-bold text-[var(--gray-12)]">
          AgentRail Console
        </h1>
        <p className="mt-2 text-sm text-[var(--gray-11)]">
          Sign in to access your workspace.
        </p>
        <form
          className="mt-6"
          action={async () => {
            "use server";
            await signIn("github", { redirectTo: "/dashboard" });
          }}
        >
          <Button type="submit" className="w-full">
            Sign in with GitHub
          </Button>
        </form>
      </div>
    </div>
  );
}

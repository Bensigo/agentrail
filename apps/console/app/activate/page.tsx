import { auth, signIn } from "@agentrail/auth";
import { ActivateForm } from "./activate-form";

/**
 * Runner activation page. A logged-in operator types the short `user_code` their
 * self-hosted runner printed and approves it, binding the runner to their
 * workspace. Session-authenticated (NextAuth) — not bearer. Unauthenticated
 * visitors are prompted to sign in first (returning here afterwards).
 */
export default async function ActivatePage() {
  const session = await auth();

  if (!session?.user?.id) {
    return (
      <main
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          fontFamily: "system-ui, sans-serif",
          gap: "1rem",
          textAlign: "center",
          padding: "2rem",
        }}
      >
        <h1 style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>
          Authorize a runner
        </h1>
        <p style={{ color: "#666", maxWidth: "40ch" }}>
          Sign in with GitHub to approve the self-hosted runner waiting for your
          code.
        </p>
        <form
          action={async () => {
            "use server";
            await signIn("github", { redirectTo: "/activate" });
          }}
        >
          <button
            type="submit"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "0.75rem 1.5rem",
              fontSize: "1rem",
              fontWeight: 500,
              background: "#24292e",
              color: "#fff",
              border: "none",
              borderRadius: "6px",
              cursor: "pointer",
            }}
          >
            Sign in with GitHub
          </button>
        </form>
      </main>
    );
  }

  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        padding: "2rem",
      }}
    >
      <ActivateForm />
    </main>
  );
}

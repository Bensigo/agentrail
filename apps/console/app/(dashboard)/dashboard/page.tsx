import { auth, signOut } from "@agentrail/auth";

export default async function DashboardPage() {
  const session = await auth();

  return (
    <main
      style={{
        padding: "2rem",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1>AgentRail Console</h1>
      <p>Welcome, {session?.user?.name ?? session?.user?.email}</p>
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/login" });
        }}
      >
        <button
          type="submit"
          style={{
            marginTop: "1rem",
            padding: "0.5rem 1rem",
            cursor: "pointer",
          }}
        >
          Logout
        </button>
      </form>
    </main>
  );
}

import { auth, signOut } from "@agentrail/auth";
import { redirect } from "next/navigation";

interface Props {
  params: Promise<{ workspaceId: string }>;
}

export default async function WorkspaceDashboardPage({ params }: Props) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const { workspaceId } = await params;

  return (
    <div style={{ padding: "2rem" }}>
      <h1 style={{ marginBottom: "0.5rem", fontSize: "1.25rem", fontWeight: 600 }}>
        AgentRail Console
      </h1>
      <p style={{ color: "var(--gray-08, #888)", fontSize: "0.875rem", marginBottom: "2rem" }}>
        Workspace: {workspaceId}
      </p>
      <p>Welcome, {session.user.name ?? session.user.email}</p>
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/login" });
        }}
      >
        <button
          type="submit"
          style={{
            marginTop: "1.5rem",
            padding: "0.5rem 1rem",
            cursor: "pointer",
            background: "var(--gray-03, #222)",
            color: "var(--gray-12, #ededed)",
            border: "1px solid var(--gray-05, #333)",
            borderRadius: "6px",
            fontSize: "0.875rem",
          }}
        >
          Logout
        </button>
      </form>
    </div>
  );
}

import { auth } from "@agentrail/auth";
import { listWorkspacesForUser } from "@agentrail/db-postgres";
import { redirect } from "next/navigation";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const userId = (session.user as typeof session.user & { id?: string }).id;
  if (!userId) {
    redirect("/login");
  }

  const workspaces = await listWorkspacesForUser(userId);
  const first = workspaces[0];

  if (first) {
    redirect(`/dashboard/${first.id}/`);
  }

  return (
    <div style={{ padding: "2rem" }}>
      <h1>No workspaces found</h1>
      <p>You are not a member of any workspace yet.</p>
    </div>
  );
}

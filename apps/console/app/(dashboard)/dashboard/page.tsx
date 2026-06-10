import { auth } from "@agentrail/auth";
import { listWorkspacesForUser } from "@agentrail/db-postgres";
import { redirect } from "next/navigation";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }

  const workspaces = await listWorkspacesForUser(session.user.id);
  if (workspaces.length > 0) {
    redirect(`/dashboard/${workspaces[0].id}`);
  }

  // Defensive fallback: no workspaces → send to setup
  redirect("/setup");
}

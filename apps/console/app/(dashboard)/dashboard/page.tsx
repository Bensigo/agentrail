import { redirect } from "next/navigation";
import { getSession, getWorkspacesForUser } from "../../../lib/cached";

export default async function DashboardPage() {
  const session = await getSession();
  if (!session?.user?.id) {
    redirect("/login");
  }

  const workspaces = await getWorkspacesForUser(session.user.id);
  if (workspaces.length > 0) {
    redirect(`/dashboard/${workspaces[0].id}`);
  }

  // Defensive fallback: no workspaces → send to setup
  redirect("/setup");
}

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

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        <h1 className="text-lg font-bold text-[var(--gray-12)]">
          No workspaces
        </h1>
        <p className="mt-2 text-sm text-[var(--gray-09)]">
          You are not a member of any workspace yet.
        </p>
      </div>
    </div>
  );
}

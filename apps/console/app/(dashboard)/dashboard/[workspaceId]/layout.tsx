import { auth, signOut } from "@agentrail/auth";
import { listWorkspacesForUser } from "@agentrail/db-postgres";
import { redirect } from "next/navigation";
import { Sidebar } from "../../../components/sidebar";
import { ThemeToggle } from "../../../components/theme-toggle";

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }

  const workspaces = await listWorkspacesForUser(session.user.id);

  async function handleSignOut() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar
        workspaces={workspaces}
        workspaceId={workspaceId}
        user={session.user}
        signOutAction={handleSignOut}
      />
      <div className="flex-1 pl-[220px] max-md:pl-12">
        <div className="flex h-12 items-center justify-end border-b border-[var(--gray-05)] px-4">
          <ThemeToggle />
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}

import { Suspense } from "react";
import { signOut } from "@agentrail/auth";
import { notFound, redirect } from "next/navigation";
import { isGoalLoopEnabled } from "@agentrail/db-postgres";
import { Sidebar } from "../../../components/sidebar";
import { ThemeToggle } from "../../../components/theme-toggle";
import { TopBarBreadcrumb } from "../../../components/breadcrumb";
import { getSession, getMembership } from "../../../../lib/cached";
import { isConsoleChatEnabled } from "../../../../lib/chat/feature-flags";
import { SidebarWithWorkspaces } from "./sidebar-with-workspaces";

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const [{ workspaceId }, session] = await Promise.all([params, getSession()]);
  if (!session?.user?.id) {
    redirect("/login");
  }

  // Authorization: a valid session is not enough — the user must be a member of
  // THIS workspace. Without this guard any logged-in user could read another
  // workspace's data (failures, runs, costs…) by guessing its id. Cached, so the
  // pages this layout wraps reuse the same lookup rather than re-querying.
  // `isGoalLoopEnabled` runs alongside it — it only depends on workspaceId, not
  // on membership having resolved, so there's no reason to serialize them.
  const [membership, goalsEnabled] = await Promise.all([
    getMembership(session.user.id, workspaceId),
    isGoalLoopEnabled(workspaceId),
  ]);
  if (!membership) {
    notFound();
  }

  async function handleSignOut() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }

  const chatEnabled = isConsoleChatEnabled(workspaceId);

  return (
    <div className="flex min-h-screen">
      <Suspense
        fallback={
          <Sidebar
            workspaces={[]}
            workspaceId={workspaceId}
            user={session.user}
            signOutAction={handleSignOut}
            chatEnabled={chatEnabled}
            goalsEnabled={goalsEnabled}
          />
        }
      >
        <SidebarWithWorkspaces
          userId={session.user.id}
          workspaceId={workspaceId}
          user={session.user}
          signOutAction={handleSignOut}
          chatEnabled={chatEnabled}
          goalsEnabled={goalsEnabled}
        />
      </Suspense>
      <div className="flex-1 pl-[220px] max-md:pl-12">
        <div className="flex h-12 items-center justify-between border-b border-[var(--gray-05)] px-4">
          <TopBarBreadcrumb />
          <ThemeToggle />
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}

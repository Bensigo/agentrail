import { Suspense } from "react";
import { signOut } from "@agentrail/auth";
import { notFound, redirect } from "next/navigation";
import { Sidebar } from "../../../components/sidebar";
import { ThemeToggle } from "../../../components/theme-toggle";
import { TopBarBreadcrumb } from "../../../components/breadcrumb";
import {
  getSession,
  getWorkspacesForUser,
  getMembership,
} from "../../../../lib/cached";

type SidebarUser = {
  name?: string | null;
  email?: string | null;
  image?: string | null;
};

// Streams in the workspace list for the switcher without blocking the page
// shell: the surrounding Suspense fallback renders the full sidebar (nav,
// user, sign-out) immediately with an empty switcher.
async function SidebarWithWorkspaces({
  userId,
  workspaceId,
  user,
  signOutAction,
}: {
  userId: string;
  workspaceId: string;
  user: SidebarUser;
  signOutAction: () => Promise<void>;
}) {
  const workspaces = await getWorkspacesForUser(userId);
  return (
    <Sidebar
      workspaces={workspaces}
      workspaceId={workspaceId}
      user={user}
      signOutAction={signOutAction}
    />
  );
}

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
  const membership = await getMembership(session.user.id, workspaceId);
  if (!membership) {
    notFound();
  }

  async function handleSignOut() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }

  return (
    <div className="flex min-h-screen">
      <Suspense
        fallback={
          <Sidebar
            workspaces={[]}
            workspaceId={workspaceId}
            user={session.user}
            signOutAction={handleSignOut}
          />
        }
      >
        <SidebarWithWorkspaces
          userId={session.user.id}
          workspaceId={workspaceId}
          user={session.user}
          signOutAction={handleSignOut}
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

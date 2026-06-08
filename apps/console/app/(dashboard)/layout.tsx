import { auth, signOut } from "@agentrail/auth";
import { redirect } from "next/navigation";
import { Button } from "@agentrail/ui";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  return (
    <div className="min-h-screen bg-[var(--gray-00)]">
      <header className="flex h-12 items-center justify-between border-b border-[var(--gray-05)] bg-[var(--gray-01)] px-4">
        <span className="text-sm font-bold text-[var(--gray-12)]">
          AgentRail Console
        </span>
        <div className="flex items-center gap-3">
          <span className="text-xs text-[var(--gray-11)]">
            {session.user.name ?? session.user.email}
          </span>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/login" });
            }}
          >
            <Button variant="ghost" size="sm" type="submit">
              Sign out
            </Button>
          </form>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}

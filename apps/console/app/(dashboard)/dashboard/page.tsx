import { auth } from "@agentrail/auth";

export default async function DashboardPage() {
  const session = await auth();

  return (
    <div className="mx-auto max-w-[1440px] p-6">
      <h1 className="text-2xl font-bold tracking-tight text-[var(--gray-12)]">
        Dashboard
      </h1>
      <p className="mt-2 text-sm text-[var(--gray-11)]">
        Welcome back, {session?.user?.name ?? "agent operator"}.
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {["Runs", "Context Packs", "Failures", "Review Gates"].map(
          (label) => (
            <div
              key={label}
              className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4"
            >
              <p className="text-xs uppercase tracking-wide text-[var(--gray-09)]">
                {label}
              </p>
              <p className="mt-2 font-mono text-2xl font-bold text-[var(--gray-12)]">
                —
              </p>
            </div>
          )
        )}
      </div>
    </div>
  );
}

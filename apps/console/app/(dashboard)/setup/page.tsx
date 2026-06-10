import Link from "next/link";

export default function SetupPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--gray-00)]">
      <div className="w-full max-w-sm rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-6">
        <h1 className="mb-2 text-base font-bold text-[var(--gray-12)]">
          Set up your workspace
        </h1>
        <p className="mb-4 text-sm text-[var(--gray-09)]">
          You are not a member of any workspace yet. Ask a workspace owner to
          invite you, or create a new workspace.
        </p>
        <Link
          href="/"
          className="text-sm text-[var(--gray-11)] underline hover:text-[var(--gray-12)]"
        >
          Back to home
        </Link>
      </div>
    </div>
  );
}

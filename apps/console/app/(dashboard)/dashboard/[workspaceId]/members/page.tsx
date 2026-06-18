import MembersClient from "./members-client";

// "Team" page: workspace members (+ invites).
export default async function TeamPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  await params;

  return (
    <div className="mx-auto max-w-[1440px] space-y-10">
      <MembersClient />
    </div>
  );
}

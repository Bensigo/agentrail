import MembersClient from "./members-client";
import { TeamsSection } from "./teams-section";

// "Team" page: workspace members (+ invites) and teams in one place.
export default async function TeamPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  return (
    <div className="mx-auto max-w-[1440px] space-y-10">
      <MembersClient />
      <TeamsSection workspaceId={workspaceId} />
    </div>
  );
}

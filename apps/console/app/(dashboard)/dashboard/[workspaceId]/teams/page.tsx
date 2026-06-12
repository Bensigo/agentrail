import { redirect } from "next/navigation";

// Teams now lives on the combined Team page alongside members.
export default async function TeamsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  redirect(`/dashboard/${workspaceId}/members`);
}

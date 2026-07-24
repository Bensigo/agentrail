import { redirect } from "next/navigation";

// Repos & Health folded into the Wiki view (owner ruling): the wiki is now
// the per-repo evidence page (repo list with health chips + the compiled
// wiki, one surface instead of two). Old deep links keep working — same
// redirect-stub shape as teams/page.tsx -> /members.
export default async function ReposPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  redirect(`/dashboard/${workspaceId}/wiki`);
}

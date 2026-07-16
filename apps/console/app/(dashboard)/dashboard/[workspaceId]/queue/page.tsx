import { redirect } from "next/navigation";

/**
 * `/queue` → `/work` (spec §3: "Work — new `/work`; `/queue` redirects to
 * it"). Deep links (bookmarks, old nav, chat links) must keep working, so
 * this stays a real route rather than being deleted. The Issue Queue page
 * components (`./components/*`) stay importable — the API route
 * (`api/v1/workspaces/[workspaceId]/queue/route.ts`) still serves this
 * workspace's durable queue — but no page renders them anymore.
 */
export default async function QueuePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  redirect(`/dashboard/${workspaceId}/work`);
}

import { redirect } from "next/navigation";
export default async function Home({ params }: { params: Promise<{ workspaceId: string }> }) {
  redirect(`/dashboard/${(await params).workspaceId}/office`);
}

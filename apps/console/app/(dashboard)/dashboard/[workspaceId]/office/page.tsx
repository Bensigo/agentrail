import { notFound } from "next/navigation";
import { readWorkflowOffice } from "@agentrail/db-postgres";
import { getMembership, getSession } from "../../../../../lib/cached";
import { Office } from "./office";
import type { OfficeSnapshot } from "./office-model";
export default async function OfficePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const session = await getSession();
  if (
    !session?.user?.id ||
    !(await getMembership(session.user.id, workspaceId))
  )
    return notFound();
  const initial = await readWorkflowOffice(workspaceId);
  return (
    <Office
      key={workspaceId}
      workspaceId={workspaceId}
      initial={initial as unknown as OfficeSnapshot}
    />
  );
}

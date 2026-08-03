import { ChangeRecordView } from "./components/change-record-view";

export default async function ChangeRecordPage({
  params,
}: {
  params: Promise<{ workspaceId: string; recordId: string }>;
}) {
  const { workspaceId, recordId } = await params;
  return <ChangeRecordView workspaceId={workspaceId} recordId={recordId} />;
}

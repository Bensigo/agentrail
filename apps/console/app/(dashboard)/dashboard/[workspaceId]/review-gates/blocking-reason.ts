export interface BlockingReason {
  title: string;
  body: string;
  file: string | null;
  severity: string;
}

export type BlockingReasonInput = string | BlockingReason;

function isBlockingReasonObject(r: BlockingReasonInput): r is BlockingReason {
  return typeof r === "object" && r !== null;
}

export function blockingReasonLabel(reason: BlockingReasonInput): string {
  if (!isBlockingReasonObject(reason)) return reason;
  const parts = [reason.title, reason.body];
  if (reason.file) parts.push(reason.file);
  return parts.join(" — ");
}

export function blockingReasonSeverity(reason: BlockingReasonInput): string | null {
  if (!isBlockingReasonObject(reason)) return null;
  return reason.severity;
}

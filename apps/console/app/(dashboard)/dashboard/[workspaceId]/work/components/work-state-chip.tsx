import {
  formatParkReason,
  workStateLabel,
  WORK_STATE_CHIP_CLASSNAME,
  type QueueEntryView,
} from "../../../../../../lib/work-vocabulary";

/**
 * The Work surface's status chip — user-facing vocabulary (spec §3), never
 * the technical `queueStateLabel`. A parked entry surfaces its human reason
 * (unmet blockers) directly under the chip so "Blocked" is never a dead end.
 */
export function WorkStateChip({ entry }: { entry: QueueEntryView }) {
  const reason =
    entry.state === "parked"
      ? formatParkReason(entry.parkReason, entry.blockedBy)
      : undefined;
  return (
    <div className="flex flex-col gap-0.5">
      <span
        className={`inline-flex w-fit items-center px-1.5 py-0.5 rounded-sm text-xs font-medium ${WORK_STATE_CHIP_CLASSNAME[entry.state]}`}
      >
        {workStateLabel(entry.state)}
      </span>
      {reason && (
        <span className="text-xs text-[var(--gray-09)]">{reason}</span>
      )}
    </div>
  );
}

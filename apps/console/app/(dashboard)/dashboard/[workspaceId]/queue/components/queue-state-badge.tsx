import {
  queueStateLabel,
  WORK_STATE_CHIP_CLASSNAME,
  type QueueState,
} from "../../../../../../lib/work-vocabulary";

export function QueueStateBadge({ state }: { state: QueueState }) {
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded-sm text-xs font-medium ${WORK_STATE_CHIP_CLASSNAME[state]}`}
    >
      {queueStateLabel(state)}
    </span>
  );
}

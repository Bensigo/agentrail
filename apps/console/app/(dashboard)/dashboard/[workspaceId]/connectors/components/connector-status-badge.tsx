import {
  connectorStatusLabel,
  type ConnectorAvailability,
  type ConnectorStatus,
} from "./connector-helpers";

// Severity mapping from TASTE.md: green=connected/active, gray=not connected,
// yellow=planned (available soon, can't be acted on yet).
export function ConnectorStatusBadge({
  status,
  availability,
}: {
  status: ConnectorStatus;
  availability: ConnectorAvailability;
}) {
  if (availability === "planned") {
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-xs font-medium bg-[var(--yellow-09)]/15 text-[var(--yellow-11)] border border-[var(--yellow-09)]/30">
        Planned
      </span>
    );
  }
  const className =
    status === "connected"
      ? "bg-[var(--green-09)]/20 text-[var(--green-11)] border border-[var(--green-09)]/30"
      : "bg-[var(--gray-04)] text-[var(--gray-10)] border border-[var(--gray-06)]";
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded-sm text-xs font-medium ${className}`}
    >
      {connectorStatusLabel(status)}
    </span>
  );
}

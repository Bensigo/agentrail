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
      <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-xs font-medium bg-[#ffe629]/15 text-[#f5e147] border border-[#ffe629]/30">
        Planned
      </span>
    );
  }
  const className =
    status === "connected"
      ? "bg-[#29a383]/20 text-[#1fd8a4] border border-[#29a383]/30"
      : "bg-[var(--gray-04)] text-[var(--gray-10)] border border-[var(--gray-06)]";
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded-sm text-xs font-medium ${className}`}
    >
      {connectorStatusLabel(status)}
    </span>
  );
}

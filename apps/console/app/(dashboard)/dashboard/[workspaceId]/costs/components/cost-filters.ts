export type TimeRange = "1h" | "6h" | "24h" | "7d" | "30d" | "";

export const TIME_RANGES: { label: string; value: TimeRange }[] = [
  { label: "All", value: "" },
  { label: "1h", value: "1h" },
  { label: "6h", value: "6h" },
  { label: "24h", value: "24h" },
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
];

export function timeRangeToFrom(
  range: TimeRange,
  now: Date = new Date()
): Date | undefined {
  if (!range) return undefined;
  const ms: Record<Exclude<TimeRange, "">, number> = {
    "1h": 1 * 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
  };
  return new Date(now.getTime() - ms[range]);
}

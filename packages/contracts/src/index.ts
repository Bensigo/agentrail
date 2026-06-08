export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "blocked";

export type HealthState =
  | "healthy"
  | "degraded"
  | "stale"
  | "error"
  | "unknown";

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

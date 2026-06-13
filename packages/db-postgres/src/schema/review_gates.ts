import { pgTable, uuid, text, timestamp, pgEnum, jsonb } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { runs } from "./runs.js";

export const reviewGateStatusEnum = pgEnum("review_gate_status", [
  "passed",
  "failed",
  "pending",
]);

export const reviewGateFindingCategories = [
  "tests",
  "visual",
  "citations",
  "ac",
  "blocked",
] as const;

export type ReviewGateFindingCategory = (typeof reviewGateFindingCategories)[number];

export type ReviewGateFinding = {
  severity: "critical" | "major" | "minor";
  category: ReviewGateFindingCategory;
  description: string;
  suggested_fix: string;
};

export const reviewGates = pgTable("review_gates", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  gateName: text("gate_name").notNull(),
  status: reviewGateStatusEnum("status").notNull().default("pending"),
  conditions: jsonb("conditions").$type<Record<string, unknown>[]>().default([]),
  blockingReasons: jsonb("blocking_reasons").$type<string[]>().default([]),
  evidenceRefs: jsonb("evidence_refs").$type<Array<{ label: string; url: string }>>().default([]),
  findings: jsonb("findings").$type<ReviewGateFinding[]>().default([]),
  evaluatedAt: timestamp("evaluated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ReviewGate = typeof reviewGates.$inferSelect;
export type NewReviewGate = typeof reviewGates.$inferInsert;
export type ReviewGateStatus = "passed" | "failed" | "pending";

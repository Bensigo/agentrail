import { pgTable, uuid, timestamp, pgEnum, primaryKey } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

export const workspaceRoleEnum = pgEnum("workspace_role", [
  "owner",
  "admin",
  "member",
  "viewer",
]);

export const workspaceMemberships = pgTable(
  "workspace_memberships",
  {
    userId: uuid("user_id").notNull(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    role: workspaceRoleEnum("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.workspaceId] })]
);

export type WorkspaceMembership = typeof workspaceMemberships.$inferSelect;
export type NewWorkspaceMembership = typeof workspaceMemberships.$inferInsert;

import { pgTable, uuid, text, timestamp, pgEnum } from "drizzle-orm/pg-core";

export const membershipRoleEnum = pgEnum("membership_role", [
  "owner",
  "admin",
  "member",
  "viewer",
]);

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workspaceMemberships = pgTable("workspace_memberships", {
  userId: text("user_id").notNull(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  role: membershipRoleEnum("role").notNull().default("member"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

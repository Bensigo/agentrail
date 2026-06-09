import { pgTable, uuid, timestamp, pgEnum, primaryKey } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";

export const teamRoleEnum = pgEnum("team_role", ["owner", "member"]);

export const teamMemberships = pgTable(
  "team_memberships",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    role: teamRoleEnum("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.teamId, table.userId] })]
);

export type TeamMembership = typeof teamMemberships.$inferSelect;
export type NewTeamMembership = typeof teamMemberships.$inferInsert;

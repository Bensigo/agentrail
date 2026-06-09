import { pgTable, uuid, primaryKey } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";
import { repositories } from "./repositories.js";

export const teamRepositories = pgTable(
  "team_repositories",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.teamId, table.repositoryId] })]
);

export type TeamRepository = typeof teamRepositories.$inferSelect;
export type NewTeamRepository = typeof teamRepositories.$inferInsert;

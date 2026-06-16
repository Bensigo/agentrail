import { pgTable, uuid, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { apiKeys } from "./api_keys.js";

/**
 * Device-authorization (OAuth device-flow) records for the self-hosted runner.
 *
 * The runner CLI starts a device flow (`POST /api/v1/auth/device/start`), shows
 * the operator a short `user_code`, then polls (`POST /api/v1/auth/device/token`)
 * until a logged-in operator approves it in the console `/activate` page. On
 * approval we mint an `api_keys` row for the operator's workspace and stamp it
 * here; the runner then exchanges its `device_code` once for that raw key, which
 * becomes its long-lived runner token (validated by `requireBearer`).
 *
 * Rows are short-lived: a pending record expires (`expiresAt`) ~15 minutes after
 * it is created and is single-use (`consumedAt` is set when the token is handed
 * out exactly once).
 */
export const deviceCodes = pgTable("device_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  // The opaque code the runner CLI holds and polls with.
  deviceCode: text("device_code").notNull().unique(),
  // The short human code the operator types into /activate (e.g. WDJB-MJHT).
  userCode: text("user_code").notNull().unique(),
  // Resolved from the approving operator's session; null until approved.
  workspaceId: uuid("workspace_id").references(() => workspaces.id, {
    onDelete: "cascade",
  }),
  // The minted runner key handed back to the runner; null until approved.
  apiKeyId: uuid("api_key_id").references(() => apiKeys.id, {
    onDelete: "set null",
  }),
  approved: boolean("approved").notNull().default(false),
  // Set once when the runner exchanges the code for its token (single-use).
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type DeviceCode = typeof deviceCodes.$inferSelect;
export type NewDeviceCode = typeof deviceCodes.$inferInsert;

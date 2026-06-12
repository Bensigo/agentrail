import { cache } from "react";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  listWorkspacesForUser,
} from "@agentrail/db-postgres";

/**
 * Request-scoped, deduplicated data accessors.
 *
 * In the App Router, layouts and the pages they wrap render in the same React
 * tree for a request, but each one that calls `auth()` or a membership lookup
 * directly pays for its own round trip. Wrapping the shared lookups in React
 * `cache()` means the dashboard layout, the workspace layout, and the page all
 * resolve from a single in-flight call per request.
 */
export const getSession = cache(() => auth());

export const getWorkspacesForUser = cache((userId: string) =>
  listWorkspacesForUser(userId)
);

export const getMembership = cache((userId: string, workspaceId: string) =>
  getWorkspaceMembership(userId, workspaceId)
);

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString =
  process.env.DATABASE_URL ??
  "postgresql://agentrail:agentrail@localhost:5432/agentrail";

const queryClient = postgres(connectionString);

export const db = drizzle(queryClient, { schema });
export { queryClient };

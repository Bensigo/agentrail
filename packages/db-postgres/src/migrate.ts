import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgres://agentrail:agentrail@localhost:5432/agentrail";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(__dirname, "../drizzle/migrations");

async function runMigrations() {
  const client = postgres(DATABASE_URL, { max: 1 });
  const db = drizzle(client);

  console.log("Running migrations from:", migrationsFolder);
  await migrate(db, { migrationsFolder });
  console.log("Migrations complete.");

  await client.end();
}

runMigrations().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});

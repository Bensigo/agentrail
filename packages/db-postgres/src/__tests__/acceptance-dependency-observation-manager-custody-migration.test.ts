import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../drizzle/migrations/0106_acceptance_dependency_observation_manager_custody.sql",
  import.meta.url,
);

describe("0106 dependency observation manager custody migration", () => {
  it("follows the pnpm claim table at the next migration index", async () => {
    const [migration, journalText] = await Promise.all([
      readFile(fileURLToPath(migrationUrl), "utf8"),
      readFile(fileURLToPath(new URL("../../drizzle/migrations/meta/_journal.json", import.meta.url)), "utf8"),
    ]);
    const journal = JSON.parse(journalText) as { entries: Array<{ idx: number; tag: string }> };

    expect(journal.entries).toContainEqual(expect.objectContaining({
      idx: 111,
      tag: "0106_acceptance_dependency_observation_manager_custody",
    }));
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "manager_custody" jsonb NOT NULL');
    expect(migration).toContain('jsonb_typeof("manager_custody") = \'object\'');
  });
});

describe.skipIf(!process.env["DATABASE_URL"])("0106 manager custody migration compatibility", () => {
  it("upgrades a 0105-shaped claim table and enforces object custody", async () => {
    const migration = await readFile(fileURLToPath(migrationUrl), "utf8");
    const schema = `dependency_manager_custody_${randomUUID().replaceAll("-", "")}`;
    const client = postgres(process.env["DATABASE_URL"]!, { max: 1 });
    const claimId = randomUUID();
    try {
      await client.unsafe(`CREATE SCHEMA "${schema}"`);
      await client.unsafe(`SET search_path TO "${schema}"`);
      await client.unsafe(`
        CREATE TABLE acceptance_dependency_observation_claims (
          id uuid PRIMARY KEY,
          head_sha text NOT NULL,
          authority_generation integer NOT NULL,
          acceptance_contract_version integer NOT NULL,
          acceptance_contract_sha256 text NOT NULL,
          compiled_pack_sha256 text NOT NULL,
          github_installation_identity_sha256 text NOT NULL,
          candidate_fingerprint text NOT NULL,
          candidate jsonb NOT NULL,
          profile jsonb NOT NULL,
          claim_token_sha256 text NOT NULL,
          claimed_at timestamptz NOT NULL,
          lease_expires_at timestamptz NOT NULL,
          consumed_at timestamptz,
          observation_event_id uuid,
          CONSTRAINT acceptance_dependency_observation_claims_custody_check CHECK (
            lease_expires_at > claimed_at
            AND ((consumed_at IS NULL) = (observation_event_id IS NULL))
          )
        )
      `);

      const migrationSql = migration.replaceAll("--> statement-breakpoint", "");
      await client.unsafe(migrationSql);
      await client.unsafe(migrationSql);
      await client`INSERT INTO acceptance_dependency_observation_claims (
        id, head_sha, authority_generation, acceptance_contract_version,
        acceptance_contract_sha256, compiled_pack_sha256,
        github_installation_identity_sha256, candidate_fingerprint,
        candidate, profile, claim_token_sha256, claimed_at, lease_expires_at
      ) VALUES (
        ${claimId}, ${"a".repeat(40)}, 1, 1,
        ${"b".repeat(64)}, ${"c".repeat(64)}, ${"d".repeat(64)},
        ${`sha256:${"e".repeat(64)}`},
        ${client.json({ package: "gopkg.in/yaml.v3" })},
        ${client.json({ manager: "go-modules" })}, ${"f".repeat(64)},
        now(), now() + interval '5 minutes'
      )`;
      const rows = await client`SELECT manager_custody FROM acceptance_dependency_observation_claims WHERE id = ${claimId}`;
      expect(rows[0]?.manager_custody).toEqual({});
      await expect(client`
        UPDATE acceptance_dependency_observation_claims
        SET manager_custody = ${client.json([])}
        WHERE id = ${claimId}
      `).rejects.toMatchObject({ code: "23514" });
      await expect(client`
        UPDATE acceptance_dependency_observation_claims
        SET github_installation_identity_sha256 = ${"D".repeat(64)}
        WHERE id = ${claimId}
      `).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.unsafe("SET search_path TO public").catch(() => undefined);
      await client.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await client.end();
    }
  }, 30_000);
});

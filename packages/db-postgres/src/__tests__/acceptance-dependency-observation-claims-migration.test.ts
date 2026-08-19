import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

describe("0105 dependency observation claim migration", () => {
  it("appends opaque, bounded claims after exact-Pack delivery custody", async () => {
    const [migration, journalText] = await Promise.all([
      readFile(fileURLToPath(new URL(
        "../../drizzle/migrations/0105_acceptance_dependency_observation_claims.sql",
        import.meta.url,
      )), "utf8"),
      readFile(fileURLToPath(new URL("../../drizzle/migrations/meta/_journal.json", import.meta.url)), "utf8"),
    ]);
    const journal = JSON.parse(journalText) as { entries: Array<{ idx: number; tag: string }> };

    expect(journal.entries).toContainEqual(expect.objectContaining({
      idx: 110,
      tag: "0105_acceptance_dependency_observation_claims",
    }));
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "acceptance_dependency_observation_claims"');
    expect(migration).toContain('"claim_token_sha256" text NOT NULL');
    expect(migration).toContain('"github_installation_identity_sha256" text NOT NULL');
    expect(migration).toContain('"lease_expires_at" > "claimed_at"');
    expect(migration).toContain('(("consumed_at" IS NULL) = ("observation_event_id" IS NULL))');
    expect(migration).not.toMatch(/github_token|installation_token|access_token/u);
  });
});

describe.skipIf(!process.env["DATABASE_URL"])("0105 claim migration compatibility", () => {
  it("upgrades a 0104-shaped schema with enforced opaque claim custody", async () => {
    const migration = await readFile(fileURLToPath(new URL(
      "../../drizzle/migrations/0105_acceptance_dependency_observation_claims.sql",
      import.meta.url,
    )), "utf8");
    const schema = `dependency_claim_migration_${randomUUID().replaceAll("-", "")}`;
    const client = postgres(process.env["DATABASE_URL"]!, { max: 1 });
    const workspaceId = randomUUID();
    const recordId = randomUUID();
    const contractId = randomUUID();
    const packId = randomUUID();
    const cycleId = randomUUID();
    const validClaim = {
      id: randomUUID(),
      workspaceId,
      recordId,
      headSha: "a".repeat(40),
      cycleId,
      contractId,
      packId,
      contractSha: "b".repeat(64),
      packSha: "c".repeat(64),
      installationSha: "d".repeat(64),
      candidateFingerprint: `sha256:${"e".repeat(64)}`,
      tokenSha: "f".repeat(64),
    };
    try {
      await client.unsafe(`CREATE SCHEMA "${schema}"`);
      await client.unsafe(`SET search_path TO "${schema}"`);
      await client.unsafe(`
        CREATE TABLE workspaces (id uuid PRIMARY KEY);
        CREATE TABLE change_records (id uuid PRIMARY KEY);
        CREATE TABLE acceptance_contracts (id uuid PRIMARY KEY);
        CREATE TABLE acceptance_compiled_context_packs (id uuid PRIMARY KEY);
        CREATE TABLE change_record_events (id uuid PRIMARY KEY);
      `);
      await client`INSERT INTO workspaces (id) VALUES (${workspaceId})`;
      await client`INSERT INTO change_records (id) VALUES (${recordId})`;
      await client`INSERT INTO acceptance_contracts (id) VALUES (${contractId})`;
      await client`INSERT INTO acceptance_compiled_context_packs (id) VALUES (${packId})`;

      const migrationSql = migration.replaceAll("--> statement-breakpoint", "");
      await client.unsafe(migrationSql);
      await client.unsafe(migrationSql);
      const table = await client`SELECT to_regclass(${`${schema}.acceptance_dependency_observation_claims`}) AS name`;
      expect(table[0]?.name).toBe("acceptance_dependency_observation_claims");

      await client`INSERT INTO acceptance_dependency_observation_claims (
        id, workspace_id, record_id, head_sha, head_cycle_id, authority_generation,
        acceptance_contract_id, acceptance_contract_version, acceptance_contract_sha256,
        compiled_pack_id, compiled_pack_sha256, github_installation_identity_sha256,
        candidate_fingerprint, candidate, profile, claimed_by, claim_token_sha256,
        claimed_at, lease_expires_at
      ) VALUES (
        ${validClaim.id}, ${validClaim.workspaceId}, ${validClaim.recordId}, ${validClaim.headSha},
        ${validClaim.cycleId}, 1, ${validClaim.contractId}, 1, ${validClaim.contractSha},
        ${validClaim.packId}, ${validClaim.packSha}, ${validClaim.installationSha},
        ${validClaim.candidateFingerprint}, ${client.json({ package: "lodash" })},
        ${client.json({ manager: "pnpm" })}, 'worker:pnpm', ${validClaim.tokenSha},
        now(), now() + interval '5 minutes'
      )`;
      await expect(client`INSERT INTO acceptance_dependency_observation_claims (
        id, workspace_id, record_id, head_sha, head_cycle_id, authority_generation,
        acceptance_contract_id, acceptance_contract_version, acceptance_contract_sha256,
        compiled_pack_id, compiled_pack_sha256, github_installation_identity_sha256,
        candidate_fingerprint, candidate, profile, claimed_by, claim_token_sha256,
        claimed_at, lease_expires_at
      ) VALUES (
        ${randomUUID()}, ${validClaim.workspaceId}, ${validClaim.recordId}, ${validClaim.headSha},
        ${randomUUID()}, 1, ${validClaim.contractId}, 1, ${validClaim.contractSha},
        ${validClaim.packId}, ${validClaim.packSha}, ${"D".repeat(64)},
        ${`sha256:${"1".repeat(64)}`}, ${client.json({ package: "lodash" })},
        ${client.json({ manager: "pnpm" })}, 'worker:pnpm', ${"2".repeat(64)},
        now(), now() + interval '5 minutes'
      )`).rejects.toMatchObject({ code: "23514" });
      await expect(client`INSERT INTO acceptance_dependency_observation_claims (
        id, workspace_id, record_id, head_sha, head_cycle_id, authority_generation,
        acceptance_contract_id, acceptance_contract_version, acceptance_contract_sha256,
        compiled_pack_id, compiled_pack_sha256, github_installation_identity_sha256,
        candidate_fingerprint, candidate, profile, claimed_by, claim_token_sha256,
        claimed_at, lease_expires_at
      ) VALUES (
        ${randomUUID()}, ${validClaim.workspaceId}, ${validClaim.recordId}, ${validClaim.headSha},
        ${validClaim.cycleId}, 1, ${validClaim.contractId}, 1, ${validClaim.contractSha},
        ${validClaim.packId}, ${validClaim.packSha}, ${validClaim.installationSha},
        ${validClaim.candidateFingerprint}, ${client.json({ package: "lodash" })},
        ${client.json({ manager: "pnpm" })}, 'worker:pnpm-other', ${"3".repeat(64)},
        now(), now() + interval '5 minutes'
      )`).rejects.toMatchObject({ code: "23505" });
    } finally {
      await client.unsafe("SET search_path TO public").catch(() => undefined);
      await client.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await client.end();
    }
  }, 30_000);
});

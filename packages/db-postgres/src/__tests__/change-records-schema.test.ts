import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  acceptanceBuilderRouteCapabilityProfiles,
  acceptanceBuilderRouteGithubClaudeAckProfiles,
  acceptanceBuilderRoutes,
  acceptanceCorrectionDispatches,
  acceptanceCorrectionDispatchGithubActivations,
  acceptanceCorrectionDispatchGithubClaudeAckReceipts,
  acceptanceCorrectionDispatchGithubClaudeRepairObservations,
  acceptanceCorrectionDispatchGithubFindingPublications,
  acceptanceCorrectionDispatchGithubPreflights,
  acceptanceGatedGithubIssuePublications,
  acceptanceGatedGithubIssueRequests,
  acceptanceCompiledContextPacks,
  acceptanceContextPackSnapshots,
  acceptanceContracts,
  changeRecordEvents,
  changeRecords,
} from "../schema/change_records.js";

describe("0096 Acceptance gated GitHub issue migration", () => {
  const MIGRATION = join(
    __dirname,
    "../../drizzle/migrations/0096_acceptance_gated_github_issues.sql",
  );

  it("stores one exact-cycle request and terminal receipt with no label or retry capability", () => {
    expect(acceptanceGatedGithubIssuePublications.recordId.notNull).toBe(true);
    expect(acceptanceGatedGithubIssuePublications.headCycleId.notNull).toBe(true);
    expect(acceptanceGatedGithubIssuePublications.criterionOutcomeBundleSha256.notNull).toBe(true);
    expect(acceptanceGatedGithubIssuePublications.packets.getSQLType()).toBe("jsonb");
    const config = getTableConfig(acceptanceGatedGithubIssuePublications);
    expect(config.indexes.map((index) => index.config.name).sort()).toEqual([
      "acceptance_gated_github_issues_approval_key",
      "acceptance_gated_github_issues_github_id_key",
      "acceptance_gated_github_issues_record_cycle_key",
      "acceptance_gated_github_issues_repo_number_key",
      "acceptance_gated_github_issues_request_key",
    ]);
  });

  it("keeps schema and migration bounds identical and excludes speculative outcomes", () => {
    const sqlText = readFileSync(MIGRATION, "utf8");
    expect(sqlText).toContain('char_length("repo") BETWEEN 3 AND 201');
    expect(sqlText).toContain(
      "^[A-Za-z0-9][A-Za-z0-9._-]{0,99}/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$",
    );
    expect(sqlText).toContain('octet_length("body") BETWEEN 1 AND 24576');
    expect(sqlText).toContain("'github_rejected', 'invalid_db_issued_request'");
    expect(sqlText).not.toContain("remote_not_current");
    expect(sqlText).not.toContain('"labels"');
    expect(sqlText).not.toContain("access_token");
  });

  it("is registered directly after the repair observation migration", () => {
    const journal = JSON.parse(readFileSync(
      join(__dirname, "../../drizzle/migrations/meta/_journal.json"), "utf8",
    ));
    expect(journal.entries.find(
      (entry: { tag: string }) => entry.tag === "0096_acceptance_gated_github_issues",
    )).toMatchObject({ idx: 101, version: "7", breakpoints: true });
  });
});

describe("0097 Jace approval custody for gated GitHub issues", () => {
  const MIGRATION = join(
    __dirname,
    "../../drizzle/migrations/0097_acceptance_gated_issue_approval_custody.sql",
  );

  it("stores one Eve/member-bound opaque request and one approval-bound publication", () => {
    expect(acceptanceGatedGithubIssueRequests.workspaceId.notNull).toBe(true);
    expect(acceptanceGatedGithubIssueRequests.recordId.notNull).toBe(true);
    expect(acceptanceGatedGithubIssueRequests.jaceSessionId.notNull).toBe(true);
    expect(acceptanceGatedGithubIssueRequests.eveSessionId.notNull).toBe(true);
    expect(acceptanceGatedGithubIssueRequests.repoNormalized.notNull).toBe(true);
    expect(acceptanceGatedGithubIssueRequests.packetSetSha256.notNull).toBe(true);
    expect(acceptanceGatedGithubIssueRequests.bodySha256.notNull).toBe(true);
    expect(acceptanceGatedGithubIssueRequests.status.hasDefault).toBe(true);
    const requestConfig = getTableConfig(acceptanceGatedGithubIssueRequests);
    expect(requestConfig.indexes.map((index) => index.config.name).sort()).toEqual([
      "acceptance_gated_github_issue_requests_approval_key",
      "acceptance_gated_github_issue_requests_record_cycle_key",
      "acceptance_gated_github_issue_requests_url_key",
    ]);
    expect(acceptanceGatedGithubIssuePublications.approvalRequestId.notNull).toBe(false);
    expect(acceptanceGatedGithubIssuePublications.approvalId.notNull).toBe(false);
    expect(acceptanceGatedGithubIssuePublications.eveSessionId.notNull).toBe(false);
    expect(acceptanceGatedGithubIssuePublications.repoNormalized.notNull).toBe(true);
  });

  it("preserves protocol-v1 rows while making every v2 write approval-bound and case-normalized", () => {
    const sqlText = readFileSync(MIGRATION, "utf8");
    expect(sqlText).toContain('CREATE TABLE IF NOT EXISTS "acceptance_gated_github_issue_requests"');
    expect(sqlText).toContain('"repo_normalized" = lower("repo")');
    expect(sqlText).toContain('"request_protocol_version" IN (1, 2)');
    expect(sqlText).toContain('"approval_request_id" IS NOT NULL');
    expect(sqlText).toContain('"approval_id" IS NOT NULL');
    expect(sqlText).toContain("external_write_indeterminate");
    expect(sqlText).toContain("publication_receipt_failed");
    expect(sqlText).toContain("external_issue_wrong_repo");
    expect(sqlText).toContain("split_part(\"published_issue_url\", '/issues/', 1)");
    expect(sqlText).toContain('("repo_normalized", "github_issue_number")');
    expect(sqlText).not.toContain("access_token");
    expect(sqlText).not.toContain("refresh_token");
  });

  it("immediately follows #1704's 0096 packet custody", () => {
    const journal = JSON.parse(readFileSync(
      join(__dirname, "../../drizzle/migrations/meta/_journal.json"), "utf8",
    ));
    const migrationIndex = journal.entries.findIndex(
      (entry: { tag: string }) => entry.tag === "0097_acceptance_gated_issue_approval_custody",
    );
    expect(journal.entries[migrationIndex]).toMatchObject({
      idx: 102,
      version: "7",
      breakpoints: true,
    });
    expect(journal.entries[migrationIndex - 1]?.tag)
      .toBe("0096_acceptance_gated_github_issues");
  });
});

describe("0095 GitHub Claude repair observation migration", () => {
  const MIGRATION = join(
    __dirname,
    "../../drizzle/migrations/0095_acceptance_github_claude_repair_observations.sql"
  );

  it("stores one immutable observation per dispatch, activation, acknowledgement, and JTI", () => {
    expect(acceptanceCorrectionDispatchGithubClaudeRepairObservations.activationId.notNull)
      .toBe(true);
    expect(acceptanceCorrectionDispatchGithubClaudeRepairObservations.acknowledgementReceiptId.notNull)
      .toBe(true);
    expect(acceptanceCorrectionDispatchGithubClaudeRepairObservations.beforeHeadSha.notNull)
      .toBe(true);
    expect(acceptanceCorrectionDispatchGithubClaudeRepairObservations.afterHeadSha.notNull)
      .toBe(true);
    expect(acceptanceCorrectionDispatchGithubClaudeRepairObservations.oidcSubjectSha256.notNull)
      .toBe(true);
    const config = getTableConfig(acceptanceCorrectionDispatchGithubClaudeRepairObservations);
    expect(config.name).toBe("acceptance_correction_dispatch_github_claude_repair_obs");
    expect(config.indexes.map((index) => index.config.name).sort()).toEqual([
      "acceptance_claude_repair_observations_ack_key",
      "acceptance_claude_repair_observations_activation_key",
      "acceptance_claude_repair_observations_dispatch_key",
      "acceptance_claude_repair_observations_oidc_jti_key",
    ]);
  });

  it("pins exact A-to-B custody and retains only hashes of opaque values", () => {
    const sqlText = readFileSync(MIGRATION, "utf8");
    expect(sqlText).toContain(
      'CREATE TABLE IF NOT EXISTS "acceptance_correction_dispatch_github_claude_repair_obs"'
    );
    expect(sqlText).not.toContain(
      '"acceptance_correction_dispatch_github_claude_repair_observations"'
    );
    expect(sqlText).toContain('"before_head_sha" = "original_head_sha"');
    expect(sqlText).toContain('lower("after_head_sha") <> lower("before_head_sha")');
    expect(sqlText).toContain("github-claude/repair-observation/v1/[A-Fa-f0-9]{64}");
    expect(sqlText).toContain('"provider_session_id_sha256"');
    expect(sqlText).toContain('"oidc_jti_sha256"');
    expect(sqlText).toContain('"oidc_subject_sha256"');
    expect(sqlText).not.toContain('"provider_session_id" text');
    expect(sqlText).not.toContain('"oidc_jti" text');
    expect(sqlText).not.toContain('"oidc_subject" text');
    expect(sqlText).not.toContain('"repair_state"');
    expect(sqlText).not.toContain('"repair_head_sha"');
    expect(sqlText).not.toContain("access_token");
    expect(sqlText).not.toContain("id_token");
  });

  it("is registered directly after the acknowledgement migration", () => {
    const journal = JSON.parse(readFileSync(
      join(__dirname, "../../drizzle/migrations/meta/_journal.json"), "utf8"
    ));
    expect(journal.entries.find(
      (entry: { tag: string }) => entry.tag === "0095_acceptance_github_claude_repair_observations"
    )).toMatchObject({ idx: 100, version: "7", breakpoints: true });
  });
});

describe("0094 GitHub Claude acknowledgement migration", () => {
  const MIGRATION = join(
    __dirname,
    "../../drizzle/migrations/0094_acceptance_github_claude_acknowledgements.sql"
  );

  it("pins one immutable workflow profile and one metadata-only receipt per activation", () => {
    expect(acceptanceBuilderRouteGithubClaudeAckProfiles.capabilityProfileId.notNull).toBe(true);
    expect(acceptanceBuilderRouteGithubClaudeAckProfiles.oidcAudienceContract.notNull).toBe(true);
    expect(acceptanceBuilderRouteGithubClaudeAckProfiles.oidcSubjectContract.notNull).toBe(true);
    expect(acceptanceCorrectionDispatchGithubClaudeAckReceipts.activationId.notNull).toBe(true);
    expect(acceptanceCorrectionDispatchGithubClaudeAckReceipts.providerSessionIdSha256.notNull).toBe(true);
    expect(acceptanceCorrectionDispatchGithubClaudeAckReceipts.oidcJtiSha256.notNull).toBe(true);
    expect(acceptanceCorrectionDispatchGithubClaudeAckReceipts.oidcSubjectSha256.notNull).toBe(true);
    const profileConfig = getTableConfig(acceptanceBuilderRouteGithubClaudeAckProfiles);
    expect(profileConfig.indexes.map((index) => index.config.name).sort()).toEqual([
      "acceptance_builder_claude_ack_profiles_route_config_key",
      "acceptance_builder_claude_ack_profiles_workspace_repo_idx",
    ]);
    const receiptConfig = getTableConfig(acceptanceCorrectionDispatchGithubClaudeAckReceipts);
    expect(receiptConfig.indexes.map((index) => index.config.name).sort()).toEqual([
      "acceptance_claude_ack_receipts_activation_key",
      "acceptance_claude_ack_receipts_dispatch_key",
      "acceptance_claude_ack_receipts_oidc_jti_key",
      "acceptance_claude_ack_receipts_oidc_run_key",
    ]);
  });

  it("pins the trusted action, first attempt, hashed audience, and hash-only opaque locators", () => {
    const sqlText = readFileSync(MIGRATION, "utf8");
    expect(sqlText).toContain("activation_comment_run_attempt_sha256_v1");
    expect(sqlText).toContain("default_repo_ref_legacy_or_immutable_v1");
    expect(sqlText).toContain("6b082c41935b4c8a3b8b0ef85ba4ba4d9eeb8975");
    expect(sqlText).toContain("github_app_bot_login\" = 'jace[bot]'");
    expect(sqlText).toContain('"oidc_run_attempt" = 1');
    expect(sqlText).toContain("github-claude/ack/v1/[A-Fa-f0-9]{64}");
    expect(sqlText).toContain('"provider_session_id_sha256"');
    expect(sqlText).toContain('"oidc_jti_sha256"');
    expect(sqlText).toContain('"oidc_subject_sha256"');
    expect(sqlText).not.toContain('"provider_session_id" text');
    expect(sqlText).not.toContain('"oidc_jti" text');
    expect(sqlText).not.toContain('"oidc_subject" text');
    expect(sqlText).not.toContain("access_token");
    expect(sqlText).not.toContain("id_token");
    expect(sqlText).not.toContain("repair_head");
  });

  it("is registered directly after the two-stage carrier migration", () => {
    const journal = JSON.parse(readFileSync(
      join(__dirname, "../../drizzle/migrations/meta/_journal.json"), "utf8"
    ));
    expect(journal.entries.find(
      (entry: { tag: string }) => entry.tag === "0094_acceptance_github_claude_acknowledgements"
    )).toMatchObject({ idx: 99, version: "7", breakpoints: true });
  });
});

describe("change_records schema — declarations (Arc D storage)", () => {
  it("uses caller-supplied deterministic ids for records and events", () => {
    expect(changeRecords.id.hasDefault).toBe(false);
    expect(changeRecordEvents.id.hasDefault).toBe(false);
  });

  it("declares nullable issue/pr anchors and default-open state", () => {
    expect(changeRecords.issueNumber.notNull).toBe(false);
    expect(changeRecords.prNumber.notNull).toBe(false);
    expect(changeRecords.state.notNull).toBe(true);
    expect(changeRecords.state.hasDefault).toBe(true);
  });

  it("keeps head_shas as a non-null text array with a default", () => {
    expect(changeRecords.headShas.notNull).toBe(true);
    expect(changeRecords.headShas.hasDefault).toBe(true);
    expect(changeRecords.headShas.getSQLType()).toBe("text[]");
  });

  it("declares event payload refs as non-null jsonb", () => {
    expect(changeRecordEvents.payloadRef.notNull).toBe(true);
    expect(changeRecordEvents.payloadRef.getSQLType()).toBe("jsonb");
  });

  it("declares the unique issue and PR lookup keys", () => {
    const config = getTableConfig(changeRecords);
    expect(
      config.indexes.find((i) => i.config.name === "change_records_issue_key")
    ).toBeDefined();
    expect(
      config.indexes.find((i) => i.config.name === "change_records_pr_key")
    ).toBeDefined();
  });

  it("declares the per-record event idempotency key", () => {
    const config = getTableConfig(changeRecordEvents);
    const idx = config.indexes.find(
      (i) => i.config.name === "change_record_events_record_event_key"
    );
    expect(idx).toBeDefined();
    const columnNames = idx!.config.columns.map(
      (c) => (c as { name?: string }).name
    );
    expect(columnNames).toEqual(["record_id", "event_key"]);
  });

  it("declares versioned Acceptance Contracts with explicit draft/confirmed state", () => {
    expect(acceptanceContracts.recordId.notNull).toBe(true);
    expect(acceptanceContracts.version.notNull).toBe(true);
    expect(acceptanceContracts.status.notNull).toBe(true);
    expect(acceptanceContracts.status.hasDefault).toBe(true);
    expect(acceptanceContracts.contract.notNull).toBe(true);
    expect(acceptanceContracts.contract.getSQLType()).toBe("jsonb");
    expect(acceptanceContracts.confirmedBy.notNull).toBe(false);
    expect(acceptanceContracts.confirmedAt.notNull).toBe(false);
  });

  it("gives a manual Acceptance Record a durable work key before issue or PR anchors exist", () => {
    expect(changeRecords.workKey.notNull).toBe(false);
  });
});

describe("0092 GitHub correction carrier preflight migration", () => {
  const MIGRATION = join(
    __dirname,
    "../../drizzle/migrations/0092_acceptance_correction_dispatch_github_preflights.sql"
  );

  it("keeps preflight custody server-bound, capped, and free of secrets or carrier receipts", () => {
    expect(acceptanceCorrectionDispatchGithubPreflights.dispatchId.notNull).toBe(true);
    expect(acceptanceCorrectionDispatchGithubPreflights.baseSha.notNull).toBe(true);
    expect(acceptanceCorrectionDispatchGithubPreflights.githubInstallationIdentitySha256.notNull).toBe(true);
    expect(acceptanceCorrectionDispatchGithubPreflights.result.getSQLType()).toBe("jsonb");
    const config = getTableConfig(acceptanceCorrectionDispatchGithubPreflights);
    expect(config.indexes.map((index) => index.config.name)).toContain(
      "acceptance_correction_github_preflights_dispatch_attempt_key"
    );
    expect(config.checks.map((check) => check.name).sort()).toEqual([
      "acceptance_correction_dispatch_github_preflights_binding_check",
      "acceptance_correction_dispatch_github_preflights_status_check",
    ]);
    const sqlText = readFileSync(MIGRATION, "utf8");
    expect(sqlText).toContain("issues_write_and_pull_requests_write_v1");
    expect(sqlText).toContain('"attempt" BETWEEN 1 AND 8');
    expect(sqlText).toContain("'reserved', 'ready', 'unavailable', 'indeterminate'");
    expect(sqlText).toContain("storage_unavailable");
    expect(sqlText).not.toContain("access_token");
    expect(sqlText).not.toContain("private_key");
    expect(sqlText).not.toContain("raw_error");
    expect(sqlText).not.toContain("comment_id");
  });

  it("is registered after capability profiles", () => {
    const journal = JSON.parse(readFileSync(
      join(__dirname, "../../drizzle/migrations/meta/_journal.json"), "utf8"
    ));
    expect(journal.entries.find(
      (entry: { tag: string }) => entry.tag === "0092_acceptance_correction_dispatch_github_preflights"
    )).toMatchObject({ idx: 97, version: "7", breakpoints: true });
  });
});

describe("0093 two-stage GitHub correction carrier migration", () => {
  const MIGRATION = join(
    __dirname,
    "../../drizzle/migrations/0093_acceptance_correction_dispatch_github_comments.sql"
  );

  it("declares immutable packet and activation reservations with closed receipts", () => {
    expect(acceptanceCorrectionDispatchGithubFindingPublications.dispatchId.notNull).toBe(true);
    expect(acceptanceCorrectionDispatchGithubFindingPublications.packetId.notNull).toBe(true);
    expect(acceptanceCorrectionDispatchGithubFindingPublications.baseSha.notNull).toBe(true);
    expect(acceptanceCorrectionDispatchGithubFindingPublications.githubInstallationIdentitySha256.notNull).toBe(true);
    expect(acceptanceCorrectionDispatchGithubFindingPublications.readyPreflightId.notNull).toBe(true);
    expect(acceptanceCorrectionDispatchGithubFindingPublications.body.notNull).toBe(false);
    expect(acceptanceCorrectionDispatchGithubFindingPublications.bodySha256.notNull).toBe(false);
    expect(acceptanceCorrectionDispatchGithubActivations.dispatchId.notNull).toBe(true);
    expect(acceptanceCorrectionDispatchGithubActivations.findingCoverageSha256.notNull).toBe(true);
    expect(acceptanceCorrectionDispatchGithubActivations.packetBundleSha256.notNull).toBe(false);
    expect(acceptanceCorrectionDispatchGithubActivations.body.notNull).toBe(false);

    const findingConfig = getTableConfig(acceptanceCorrectionDispatchGithubFindingPublications);
    expect(findingConfig.indexes.map((index) => index.config.name).sort()).toEqual([
      "acceptance_correction_gh_findings_comment_receipt_key",
      "acceptance_correction_gh_findings_dispatch_packet_key",
    ]);
    expect(findingConfig.checks.map((check) => check.name).sort()).toEqual([
      "acceptance_correction_gh_findings_binding_check",
      "acceptance_correction_gh_findings_state_check",
    ]);
    const activationConfig = getTableConfig(acceptanceCorrectionDispatchGithubActivations);
    expect(activationConfig.indexes.map((index) => index.config.name).sort()).toEqual([
      "acceptance_correction_gh_activations_comment_receipt_key",
      "acceptance_correction_gh_activations_dispatch_key",
    ]);
    expect(activationConfig.checks.map((check) => check.name).sort()).toEqual([
      "acceptance_correction_gh_activations_binding_check",
      "acceptance_correction_gh_activations_state_check",
    ]);
  });

  it("creates only final tables/indexes with byte caps and closed failure reasons", () => {
    const sqlText = readFileSync(MIGRATION, "utf8");
    expect(sqlText).toContain('CREATE TABLE IF NOT EXISTS "acceptance_correction_dispatch_github_finding_publications"');
    expect(sqlText).toContain('CREATE TABLE IF NOT EXISTS "acceptance_correction_dispatch_github_activations"');
    expect(sqlText).not.toContain('ALTER TABLE "acceptance_correction_dispatch_github_finding_publications"');
    expect(sqlText).not.toContain('ALTER TABLE "acceptance_correction_dispatch_github_activations"');
    expect(sqlText).toContain('octet_length("body") BETWEEN 1 AND 12288');
    expect(sqlText).toContain('octet_length("body") BETWEEN 1 AND 61440');
    expect(sqlText).toContain("'reserved', 'published', 'bounded_failed', 'ambiguous_hold'");
    expect(sqlText).toContain("'reserved', 'carrier_accepted', 'bounded_failed', 'ambiguous_hold'");
    expect(sqlText).toContain("'github_unavailable', 'ambiguous_response'");
    expect(sqlText).toContain("'activation_body_too_large'");
    expect(sqlText).toContain('ON DELETE restrict');
    expect(sqlText).not.toContain("access_token");
    expect(sqlText).not.toContain("private_key");
    expect(sqlText).not.toContain("raw_response");
    expect(sqlText).not.toContain("agent_acknowledged");
    expect(sqlText).not.toContain("repair_head");
  });

  it("is registered directly after the preflight migration", () => {
    const journal = JSON.parse(readFileSync(
      join(__dirname, "../../drizzle/migrations/meta/_journal.json"), "utf8"
    ));
    expect(journal.entries.find(
      (entry: { tag: string }) => entry.tag === "0093_acceptance_correction_dispatch_github_comments"
    )).toMatchObject({ idx: 98, version: "7", breakpoints: true });
  });
});

describe("0070_change_records migration", () => {
  const MIGRATION = join(
    __dirname,
    "../../drizzle/migrations/0070_change_records.sql"
  );

  it("creates both tables idempotently", () => {
    const sqlText = readFileSync(MIGRATION, "utf8");
    expect(sqlText).toContain('CREATE TABLE IF NOT EXISTS "change_records"');
    expect(sqlText).toContain(
      'CREATE TABLE IF NOT EXISTS "change_record_events"'
    );
  });

  it("guards both foreign keys against re-run duplicate_object errors", () => {
    const sqlText = readFileSync(MIGRATION, "utf8");
    expect(sqlText).toContain(
      "change_records_workspace_id_workspaces_id_fk"
    );
    expect(sqlText).toContain(
      "change_record_events_record_id_change_records_id_fk"
    );
    expect(sqlText).toContain("WHEN duplicate_object THEN null");
  });

  it("creates the issue, PR, idempotency, and timeline indexes idempotently", () => {
    const sqlText = readFileSync(MIGRATION, "utf8");
    expect(sqlText).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "change_records_issue_key"'
    );
    expect(sqlText).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "change_records_pr_key"'
    );
    expect(sqlText).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "change_record_events_record_event_key"'
    );
    expect(sqlText).toContain(
      'CREATE INDEX IF NOT EXISTS "change_record_events_timeline_idx"'
    );
  });

  it("is registered in the journal at idx 74", () => {
    const journal = JSON.parse(
      readFileSync(
        join(__dirname, "../../drizzle/migrations/meta/_journal.json"),
        "utf8"
      )
    );
    const entry = journal.entries.find(
      (e: { tag: string }) => e.tag === "0070_change_records"
    );
    expect(entry).toBeDefined();
    expect(entry.idx).toBe(74);
    expect(entry.version).toBe("7");
    expect(entry.breakpoints).toBe(true);
  });
});

describe("0081_acceptance_contracts migration", () => {
  const MIGRATION = join(
    __dirname,
    "../../drizzle/migrations/0081_acceptance_contracts.sql"
  );

  it("adds manual intake identity and creates immutable contract versions", () => {
    const sqlText = readFileSync(MIGRATION, "utf8");
    expect(sqlText).toContain('ADD COLUMN IF NOT EXISTS "work_key"');
    expect(sqlText).toContain('ADD COLUMN IF NOT EXISTS "origin_channel"');
    expect(sqlText).toContain('ADD COLUMN IF NOT EXISTS "source_references"');
    expect(sqlText).toContain('CREATE TABLE IF NOT EXISTS "acceptance_contracts"');
    expect(sqlText).toContain('"contract" jsonb NOT NULL');
  });

  it("prevents duplicate contract versions and multiple confirmed contracts", () => {
    const sqlText = readFileSync(MIGRATION, "utf8");
    expect(sqlText).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_contracts_record_version_key"'
    );
    expect(sqlText).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_contracts_one_confirmed_per_record"'
    );
  });

  it("is registered in the journal", () => {
    const journal = JSON.parse(
      readFileSync(
        join(__dirname, "../../drizzle/migrations/meta/_journal.json"),
        "utf8"
      )
    );
    const entry = journal.entries.find(
      (e: { tag: string }) => e.tag === "0081_acceptance_contracts"
    );
    expect(entry).toMatchObject({ idx: 86, version: "7", breakpoints: true });
  });
});

describe("0084_acceptance_builder_routes migration", () => {
  const MIGRATION = join(
    __dirname,
    "../../drizzle/migrations/0084_acceptance_builder_routes.sql"
  );

  it("declares a workspace/repository-scoped server route registry", () => {
    expect(acceptanceBuilderRoutes.workspaceId.notNull).toBe(true);
    expect(acceptanceBuilderRoutes.repo.notNull).toBe(true);
    expect(acceptanceBuilderRoutes.adapter.notNull).toBe(true);
    expect(acceptanceBuilderRoutes.configurationVersion.notNull).toBe(true);
    expect(acceptanceBuilderRoutes.registeredBy.notNull).toBe(true);
    expect(acceptanceBuilderRoutes.status.hasDefault).toBe(true);
    const config = getTableConfig(acceptanceBuilderRoutes);
    expect(config.indexes.find((index) =>
      index.config.name === "acceptance_builder_routes_workspace_repo_status_idx"
    )).toBeDefined();
    expect(config.checks.map((check) => check.name).sort()).toEqual([
      "acceptance_builder_routes_adapter_check",
      "acceptance_builder_routes_configuration_version_check",
      "acceptance_builder_routes_registered_by_check",
      "acceptance_builder_routes_repo_check",
      "acceptance_builder_routes_status_check",
    ]);
  });

  it("constrains adapters, status, configuration version, actor, and repository", () => {
    const sqlText = readFileSync(MIGRATION, "utf8");
    for (const adapter of [
      "github_codex", "github_claude", "durable_github_fallback", "durable_jace_fallback",
    ]) expect(sqlText).toContain(`'${adapter}'`);
    expect(sqlText).not.toContain("codex_app_server");
    expect(sqlText).not.toContain("mcp_correction_inbox");
    expect(sqlText).toContain("acceptance_builder_routes_status_check");
    expect(sqlText).toContain("acceptance_builder_routes_configuration_version_check");
    expect(sqlText).toContain("acceptance_builder_routes_registered_by_check");
    expect(sqlText).toContain("acceptance_builder_routes_repo_check");
  });

  it("is registered in the migration journal", () => {
    const journal = JSON.parse(readFileSync(
      join(__dirname, "../../drizzle/migrations/meta/_journal.json"), "utf8"
    ));
    expect(journal.entries.find(
      (entry: { tag: string }) => entry.tag === "0084_acceptance_builder_routes"
    )).toMatchObject({ idx: 89, version: "7", breakpoints: true });
  });
});

describe("0085_acceptance_context_pack_snapshots migration", () => {
  const MIGRATION = join(
    __dirname,
    "../../drizzle/migrations/0085_acceptance_context_pack_snapshots.sql"
  );

  it("declares immutable exact-head snapshot anchors and metadata-only provenance", () => {
    expect(acceptanceContextPackSnapshots.workspaceId.notNull).toBe(true);
    expect(acceptanceContextPackSnapshots.recordId.notNull).toBe(true);
    expect(acceptanceContextPackSnapshots.reviewJobId.notNull).toBe(true);
    expect(acceptanceContextPackSnapshots.acceptanceContractId.notNull).toBe(true);
    expect(acceptanceContextPackSnapshots.baseSha.notNull).toBe(false);
    expect(acceptanceContextPackSnapshots.mergeBaseSha.notNull).toBe(false);
    expect(acceptanceContextPackSnapshots.headTreeSha.notNull).toBe(false);
    expect(acceptanceContextPackSnapshots.baseIndex.notNull).toBe(false);
    expect(acceptanceContextPackSnapshots.overlay.notNull).toBe(false);
    expect(acceptanceContextPackSnapshots.baseIndex.getSQLType()).toBe("jsonb");
    expect(acceptanceContextPackSnapshots.overlay.getSQLType()).toBe("jsonb");
    expect(acceptanceContextPackSnapshots.provenance.getSQLType()).toBe("jsonb");
  });

  it("makes replay identity unique and limits status to snapshot custody states", () => {
    const sqlText = readFileSync(MIGRATION, "utf8");
    expect(sqlText).toContain('CREATE TABLE IF NOT EXISTS "acceptance_context_pack_snapshots"');
    expect(sqlText).toContain('"status" IN (\'admitted\', \'not_proven\')');
    expect(sqlText).toContain("acceptance_context_pack_snapshots_reason_check");
    expect(sqlText).toContain("acceptance_context_pack_snapshots_identity_json_check");
    expect(sqlText).toContain('"acceptance_context_pack_snapshots_replay_key"');
    expect(sqlText).toContain('"acceptance_context_pack_snapshots_review_job_idx"');
  });
});

describe("0087_acceptance_compiled_context_packs migration", () => {
  const MIGRATION = join(
    __dirname,
    "../../drizzle/migrations/0087_acceptance_compiled_context_packs.sql"
  );

  it("declares an immutable metadata-only Pack row with workspace-scoped replay", () => {
    expect(acceptanceCompiledContextPacks.workspaceId.notNull).toBe(true);
    expect(acceptanceCompiledContextPacks.sourceSnapshotId.notNull).toBe(true);
    expect(acceptanceCompiledContextPacks.binding.getSQLType()).toBe("jsonb");
    expect(acceptanceCompiledContextPacks.manifest.getSQLType()).toBe("jsonb");
    expect(acceptanceCompiledContextPacks.sourceCustodyReceipt.getSQLType()).toBe("jsonb");
    expect(acceptanceCompiledContextPacks.exactHeadDependencyTreeProofs.getSQLType()).toBe("jsonb");
    const config = getTableConfig(acceptanceCompiledContextPacks);
    expect(config.indexes.find((index) =>
      index.config.name === "acceptance_compiled_context_packs_replay_key"
    )).toBeDefined();
  });

  it("is registered after the nullable 0086 custody upgrade", () => {
    const sqlText = readFileSync(MIGRATION, "utf8");
    const journal = JSON.parse(readFileSync(
      join(__dirname, "../../drizzle/migrations/meta/_journal.json"), "utf8"
    ));
    expect(sqlText).toContain('CREATE TABLE IF NOT EXISTS "acceptance_compiled_context_packs"');
    expect(sqlText).toContain('"source_snapshot_id" uuid NOT NULL REFERENCES "acceptance_context_pack_snapshots"("id") ON DELETE restrict');
    expect(sqlText).not.toContain("rendered_json");
    expect(sqlText).not.toContain("source_text");
    expect(sqlText).toContain('"exact_head_dependency_tree_proofs" jsonb NOT NULL');
    expect(journal.entries.find(
      (entry: { tag: string }) => entry.tag === "0087_acceptance_compiled_context_packs"
    )).toMatchObject({ idx: 92, version: "7", breakpoints: true });
  });
});

describe("0091_acceptance_builder_route_capability_profiles migration", () => {
  const MIGRATION = join(
    __dirname,
    "../../drizzle/migrations/0091_acceptance_builder_route_capability_profiles.sql"
  );

  it("declares an immutable GitHub-native capability profile bound to one route revision", () => {
    expect(acceptanceBuilderRouteCapabilityProfiles.workspaceId.notNull).toBe(true);
    expect(acceptanceBuilderRouteCapabilityProfiles.routeId.notNull).toBe(true);
    expect(acceptanceBuilderRouteCapabilityProfiles.repo.notNull).toBe(true);
    expect(acceptanceBuilderRouteCapabilityProfiles.adapter.notNull).toBe(true);
    expect(acceptanceBuilderRouteCapabilityProfiles.routeConfigurationVersion.notNull).toBe(true);
    expect(acceptanceBuilderRouteCapabilityProfiles.githubInstallationIdentitySha256.notNull).toBe(true);
    expect(acceptanceBuilderRouteCapabilityProfiles.snapshot.notNull).toBe(true);
    expect(acceptanceBuilderRouteCapabilityProfiles.snapshot.getSQLType()).toBe("jsonb");
    expect(acceptanceBuilderRouteCapabilityProfiles.snapshotSha256.notNull).toBe(true);
    expect(acceptanceBuilderRouteCapabilityProfiles.recordedBy.notNull).toBe(true);
    const config = getTableConfig(acceptanceBuilderRouteCapabilityProfiles);
    expect(config.indexes.find((index) =>
      index.config.name === "acceptance_builder_route_cap_profiles_route_config_key"
    )).toBeDefined();
    expect(config.checks.map((check) => check.name).sort()).toEqual([
      "acceptance_builder_route_cap_profiles_config_version_check",
      "acceptance_builder_route_capability_profiles_adapter_check",
      "acceptance_builder_route_capability_profiles_recorded_by_check",
      "acceptance_builder_route_capability_profiles_repo_check",
      "acceptance_builder_route_capability_profiles_snapshot_check",
    ]);
  });

  it("adds an all-or-nothing immutable profile snapshot to dispatches without retroactively blessing legacy rows", () => {
    expect(acceptanceCorrectionDispatches.capabilityProfileId.notNull).toBe(false);
    expect(acceptanceCorrectionDispatches.capabilityProfileSnapshot.notNull).toBe(false);
    expect(acceptanceCorrectionDispatches.capabilityProfileSnapshot.getSQLType()).toBe("jsonb");
    expect(acceptanceCorrectionDispatches.capabilityProfileSnapshotSha256.notNull).toBe(false);
    const sqlText = readFileSync(MIGRATION, "utf8");
    expect(sqlText).toContain('CREATE TABLE IF NOT EXISTS "acceptance_builder_route_capability_profiles"');
    expect(sqlText).toContain("'github_codex'");
    expect(sqlText).toContain("'github_claude'");
    expect(sqlText).not.toContain("codex_app_server");
    expect(sqlText).not.toContain("mcp_correction_inbox");
    expect(sqlText).toContain("acceptance_builder_route_cap_profiles_route_config_key");
    expect(sqlText).toContain("acceptance_correction_dispatches_capability_profile_check");
    expect(sqlText).toContain('"capability_profile_id" uuid');
    expect(sqlText).not.toContain("access_token");
    expect(sqlText).not.toContain("private_key");
  });

  it("is registered after selected-route dispatch preparation", () => {
    const journal = JSON.parse(readFileSync(
      join(__dirname, "../../drizzle/migrations/meta/_journal.json"), "utf8"
    ));
    expect(journal.entries.find(
      (entry: { tag: string }) => entry.tag === "0091_acceptance_builder_route_capability_profiles"
    )).toMatchObject({ idx: 96, version: "7", breakpoints: true });
  });
});

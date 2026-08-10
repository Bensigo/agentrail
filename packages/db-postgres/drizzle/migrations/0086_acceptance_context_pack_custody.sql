-- Extends the 0085 Context Pack snapshot admission with custody hashes.
-- Existing admitted snapshots cannot safely self-attest these values, so this
-- migration leaves them nullable and only new writes through the v2 query
-- boundary may persist them.
ALTER TABLE "acceptance_context_pack_snapshots"
  ADD COLUMN IF NOT EXISTS "acceptance_contract_sha256" text,
  ADD COLUMN IF NOT EXISTS "correction_packet_payload_set_sha256" text;
--> statement-breakpoint
ALTER TABLE "acceptance_context_pack_snapshots"
  ADD CONSTRAINT "acceptance_context_pack_snapshots_contract_sha_check"
  CHECK ("acceptance_contract_sha256" IS NULL OR "acceptance_contract_sha256" ~ '^[A-Fa-f0-9]{64}$') NOT VALID,
  ADD CONSTRAINT "acceptance_context_pack_snapshots_packet_payload_sha_check"
  CHECK ("correction_packet_payload_set_sha256" IS NULL OR "correction_packet_payload_set_sha256" ~ '^[A-Fa-f0-9]{64}$') NOT VALID;
--> statement-breakpoint

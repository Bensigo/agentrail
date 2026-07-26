-- Task-family tag on `runs` (issue #1223 AC4): what KIND of task a run is
-- (bug/feature/refactor/test/infra), mirrored onto the Langfuse trace as a
-- `family:<value>` tag (agentrail/observability/tracer.py) so solve-rate and
-- $-per-solved can be sliced by family later. Nullable and additive: there is
-- no source that classifies a live GitHub issue's family yet, so existing and
-- future unclassified rows stay NULL; the CHECK only guards rows that DO set
-- a value, against the same fixed vocabulary the eval corpus's `family` field
-- (agentrail/evals/corpus/loader.py) and agentrail/shared/task_family.py use.
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "family" text;
--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_family_check" CHECK ("runs"."family" IS NULL OR "runs"."family" IN ('bug', 'feature', 'refactor', 'test', 'infra'));
--> statement-breakpoint
-- Family-stratified breakdown (issue #1223 AC4) on `eval_arm_metrics`, same
-- shape/parity contract as the existing `strata` column
-- (agentrail/evals/reporter.py::arm_metric_rows already emits `family_strata`
-- alongside `strata`) — additive and nullable-by-default (empty array) so
-- historical rows read back as "no family data" rather than erroring.
ALTER TABLE "eval_arm_metrics" ADD COLUMN IF NOT EXISTS "family_strata" jsonb DEFAULT '[]'::jsonb;

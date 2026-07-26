import { RUN_FAMILY_VALUES, type RunFamily } from "../schema/runs.js";

/**
 * True iff `value` is one of the fixed `runs.family` vocabulary values.
 *
 * Deliberately accepts `unknown` (not just `string`) so callers can probe an
 * untrusted/optional value — a DB column read back as `null`, a caller-
 * supplied string — without a separate type guard at every call site.
 */
export function isRunFamily(value: unknown): value is RunFamily {
  return (
    typeof value === "string" &&
    (RUN_FAMILY_VALUES as readonly string[]).includes(value)
  );
}

/**
 * The Langfuse trace tag for a run's task family, or `undefined` when unset
 * or not a recognized vocabulary value.
 *
 * Pure function (issue #1223 AC4): given a `runs.family` value, returns the
 * exact tag string a Langfuse trace should carry (`"family:<value>"`), never
 * a malformed tag from a stray/typo'd value. Mirrors the Python side's
 * `agentrail.shared.task_family.family_langfuse_tag` exactly — both are
 * trivial, dependency-free, and unit-testable in complete isolation from any
 * real Langfuse client, database, or network call, so this can be verified
 * without wiring an actual live run.
 */
export function runFamilyLangfuseTag(
  family: string | null | undefined
): string | undefined {
  if (!isRunFamily(family)) return undefined;
  return `family:${family}`;
}

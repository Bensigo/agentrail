import type { AcceptanceContract } from "@agentrail/contracts";

type Result = { ok: true } | { ok: false; error: string };
const object = (value: unknown): value is Record<string, unknown> => value != null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const array = (value: unknown): value is unknown[] => Array.isArray(value);

function containsSourceContent(value: unknown): boolean {
  if (array(value)) return value.some(containsSourceContent);
  if (!object(value)) return false;
  return Object.entries(value).some(([key, nested]) =>
    key.toLowerCase() === "content" || key.toLowerCase() === "fullsource" || containsSourceContent(nested)
  );
}

/** Reject unbounded or uncited handoff metadata before it reaches the durable record. */
export function validateAcceptanceContextPackMetadata(input: {
  manifest: Record<string, unknown>;
  custody: Record<string, unknown>;
  freshness: Record<string, unknown>;
  contract: AcceptanceContract;
}): Result {
  const { manifest, custody, freshness, contract } = input;
  if (containsSourceContent(manifest) || containsSourceContent(custody) || containsSourceContent(freshness)) {
    return { ok: false, error: "Context Pack metadata must not contain source content" };
  }
  if (!Number.isInteger(manifest.tokenBudget) || (manifest.tokenBudget as number) <= 0 || !Number.isInteger(manifest.tokenCount) || (manifest.tokenCount as number) < 0 || (manifest.tokenCount as number) > (manifest.tokenBudget as number)) {
    return { ok: false, error: "manifest requires tokenBudget and tokenCount within that explicit budget" };
  }
  if (!array(manifest.sources) || manifest.sources.length === 0 || manifest.sources.some((source) => !object(source) || !text(source.path) || !text(source.citation) || !text(source.reason) || !Number.isInteger(source.startLine) || !Number.isInteger(source.endLine) || (source.startLine as number) < 1 || (source.endLine as number) < (source.startLine as number))) {
    return { ok: false, error: "manifest requires cited bounded source ranges" };
  }
  for (const field of ["architectureBoundaries", "tests", "decisions", "exclusions"]) {
    if (!array(manifest[field])) return { ok: false, error: `manifest requires an explicit ${field} list` };
  }
  if (!array(manifest.acceptanceCriteria)) return { ok: false, error: "manifest requires confirmed acceptanceCriteria" };
  const ids = manifest.acceptanceCriteria.map((value) => object(value) && text(value.id) ? value.id.trim() : null);
  const expected = contract.acceptanceCriteria.map((criterion) => criterion.id).sort();
  if (ids.some((id) => id == null) || [...new Set(ids)].length !== ids.length || ids.slice().sort().join("\u0000") !== expected.join("\u0000")) {
    return { ok: false, error: "manifest acceptanceCriteria must exactly match the confirmed contract" };
  }
  if (custody.fullSourceUploadAllowed !== false) return { ok: false, error: "custody must explicitly forbid full source upload" };
  if (!text(freshness.indexRevision) || !text(freshness.repositoryRef) || !text(freshness.compiledAt) || Number.isNaN(Date.parse(freshness.compiledAt))) {
    return { ok: false, error: "freshness requires indexRevision, repositoryRef, and compiledAt" };
  }
  return { ok: true };
}

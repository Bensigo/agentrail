import { describe, expect, it } from "vitest";
import { validateAcceptanceContextPackMetadata } from "./acceptance-context-pack-validation";

const contract = { acceptanceCriteria: [{ id: "saved", text: "Saves", required: true, userVisible: true }] } as never;
const input = {
  manifest: { tokenBudget: 1000, tokenCount: 800, sources: [{ path: "src/save.ts", citation: "src/save.ts:10-20", startLine: 10, endLine: 20, reason: "contains the save implementation" }], architectureBoundaries: [], tests: [], decisions: [], exclusions: [], acceptanceCriteria: [{ id: "saved" }] },
  custody: { fullSourceUploadAllowed: false }, freshness: { indexRevision: "abc", repositoryRef: "main", compiledAt: "2026-08-06T00:00:00.000Z" }, contract,
};
describe("acceptance Context Pack metadata", () => {
  it("requires bounded, cited sources and exact confirmed criteria", () => expect(validateAcceptanceContextPackMetadata(input)).toEqual({ ok: true }));
  it("rejects a context dump or criterion drift", () => {
    expect(validateAcceptanceContextPackMetadata({ ...input, manifest: { ...input.manifest, tokenCount: 1001 } }).ok).toBe(false);
    expect(validateAcceptanceContextPackMetadata({ ...input, manifest: { ...input.manifest, acceptanceCriteria: [{ id: "invented" }] } }).ok).toBe(false);
    expect(validateAcceptanceContextPackMetadata({ ...input, freshness: { ...input.freshness, content: "def save(): secret" } }).ok).toBe(false);
  });

  it("rejects a selected source without a reason or a freshness repository ref", () => {
    expect(validateAcceptanceContextPackMetadata({ ...input, manifest: { ...input.manifest, sources: [{ ...input.manifest.sources[0], reason: " " }] } }).ok).toBe(false);
    expect(validateAcceptanceContextPackMetadata({ ...input, freshness: { indexRevision: "abc", compiledAt: input.freshness.compiledAt } }).ok).toBe(false);
  });

  it("rejects a packet whose declared token count exceeds its budget", () => {
    expect(validateAcceptanceContextPackMetadata({ ...input, manifest: { ...input.manifest, tokenCount: 1001 } }).ok).toBe(false);
  });
});

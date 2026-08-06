import { describe, expect, it } from "vitest";
import { validateAcceptanceContextPackMetadata } from "./acceptance-context-pack-validation";

const contract = { acceptanceCriteria: [{ id: "saved", text: "Saves", required: true, userVisible: true }] } as never;
const input = {
  manifest: { tokenBudget: 1000, tokenCount: 800, sources: [{ path: "src/save.ts", citation: "src/save.ts:10-20", startLine: 10, endLine: 20 }], architectureBoundaries: [], tests: [], decisions: [], exclusions: [], acceptanceCriteria: [{ id: "saved" }] },
  custody: { fullSourceUploadAllowed: false }, freshness: { indexRevision: "abc", compiledAt: "2026-08-06T00:00:00.000Z" }, contract,
};
describe("acceptance Context Pack metadata", () => {
  it("requires bounded, cited sources and exact confirmed criteria", () => expect(validateAcceptanceContextPackMetadata(input)).toEqual({ ok: true }));
  it("rejects a context dump or criterion drift", () => {
    expect(validateAcceptanceContextPackMetadata({ ...input, manifest: { ...input.manifest, tokenCount: 1001 } }).ok).toBe(false);
    expect(validateAcceptanceContextPackMetadata({ ...input, manifest: { ...input.manifest, acceptanceCriteria: [{ id: "invented" }] } }).ok).toBe(false);
  });
});

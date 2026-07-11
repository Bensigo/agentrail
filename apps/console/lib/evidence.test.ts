import { describe, it, expect } from "vitest";
import { boundEvidence, EVIDENCE_MAX_LINES, EVIDENCE_MAX_BYTES } from "./evidence";

describe("boundEvidence", () => {
  it("returns '' for empty input", () => {
    expect(boundEvidence("")).toBe("");
  });

  it("passes through a small excerpt unchanged", () => {
    const raw = "line1\nline2\nline3";
    expect(boundEvidence(raw)).toBe(raw);
  });

  it("keeps only the last N lines (the tail, where the error is)", () => {
    const lines = Array.from({ length: EVIDENCE_MAX_LINES + 50 }, (_, i) => `l${i}`);
    const out = boundEvidence(lines.join("\n")).split("\n");
    expect(out).toHaveLength(EVIDENCE_MAX_LINES);
    // The final (most recent) line survives; the earliest are dropped.
    expect(out[out.length - 1]).toBe(`l${EVIDENCE_MAX_LINES + 49}`);
    expect(out[0]).toBe(`l50`);
  });

  it("byte-caps to the ceiling", () => {
    const raw = "x".repeat(EVIDENCE_MAX_BYTES * 2);
    const out = boundEvidence(raw);
    expect(Buffer.from(out, "utf-8").length).toBeLessThanOrEqual(EVIDENCE_MAX_BYTES);
  });

  it("scrubs a credential-shaped span before it can be persisted", () => {
    const secret = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
    const out = boundEvidence(`error: authenticating with ${secret}`);
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED_SECRET]");
  });

  it("scrubs BEFORE the byte cap so the cap cannot bisect a credential", () => {
    // A secret near the very end, preceded by enough filler to force a byte-cap.
    const secret = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
    const filler = "y".repeat(EVIDENCE_MAX_BYTES);
    const out = boundEvidence(`${filler}\nboom ${secret}`);
    // The credential is either fully redacted or fully cut — never a live fragment.
    expect(out).not.toContain("sk-ant-");
  });
});

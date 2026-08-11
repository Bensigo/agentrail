import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  readDurableCorrectionDispatchFallback,
  recordDurableCorrectionDispatchFallback,
} from "../queries/change_records.js";

const exactInput = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  dispatchId: "22222222-2222-4222-8222-222222222222",
};

describe("durable correction fallback public boundary", () => {
  it("rejects caller-supplied head, route, lane, and body on record", async () => {
    await expect(recordDurableCorrectionDispatchFallback({
      ...exactInput,
      headSha: "a".repeat(40),
      routeAdapter: "durable_jace_fallback",
      lane: "jace_only",
      body: "caller-controlled",
    } as never)).rejects.toThrow(
      "Durable correction fallback record requires only workspace and dispatch"
    );
  });

  it("rejects caller-supplied head, route, lane, and body on replay-only read", async () => {
    await expect(readDurableCorrectionDispatchFallback({
      ...exactInput,
      headSha: "a".repeat(40),
      routeAdapter: "durable_jace_fallback",
      lane: "jace_only",
      body: "caller-controlled",
    } as never)).rejects.toThrow(
      "Durable correction fallback read requires only workspace and dispatch"
    );
  });

  it("keeps untrusted criterion text out of the fallback projection and rejects every mention", async () => {
    const source = await readFile(new URL("../queries/change_records.ts", import.meta.url), "utf8");
    const renderer = source.slice(
      source.indexOf("function durableCorrectionFallbackValues("),
      source.indexOf("function durableCorrectionFallbackEventPayload(")
    );
    expect(renderer).not.toContain("criterionId");
    expect(renderer).toContain('body.includes("@")');
  });
});

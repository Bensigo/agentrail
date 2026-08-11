import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readCurrentAcceptanceCorrectionPackets } from "./change_records.js";

describe("readCurrentAcceptanceCorrectionPackets input boundary", () => {
  it("accepts only the opaque workspace and Record identity", async () => {
    const input = { workspaceId: randomUUID(), recordId: randomUUID() };

    await expect(readCurrentAcceptanceCorrectionPackets({
      ...input,
      headSha: "a".repeat(40),
    } as never)).rejects.toThrow("requires only workspace and Record");
    await expect(readCurrentAcceptanceCorrectionPackets({
      ...input,
      routeId: randomUUID(),
    } as never)).rejects.toThrow("requires only workspace and Record");
    await expect(readCurrentAcceptanceCorrectionPackets({
      ...input,
      packets: [],
    } as never)).rejects.toThrow("requires only workspace and Record");
    await expect(readCurrentAcceptanceCorrectionPackets({
      workspaceId: "not-a-workspace-id",
      recordId: input.recordId,
    })).rejects.toThrow("requires only workspace and Record");
  });
});

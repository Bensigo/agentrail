import { describe, expect, it } from "vitest";
import {
  AcceptanceDependencyExternalBuilderPackConflictError,
  approveAcceptanceDependencyObservationAndMintExternalBuilderPack,
  readCurrentAcceptanceDependencyObservations,
} from "./change_records.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const RECORD_ID = "22222222-2222-4222-8222-222222222222";
const OBSERVATION_EVENT_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";

describe("Acceptance dependency external Builder Pack input boundary", () => {
  it("accepts only the opaque approval coordinates", async () => {
    const valid = {
      workspaceId: WORKSPACE_ID,
      recordId: RECORD_ID,
      observationEventId: OBSERVATION_EVENT_ID,
      approvedBy: `user:${USER_ID}`,
    };
    for (const extra of [
      { repo: "acme/widgets" },
      { prNumber: 7 },
      { headSha: "a".repeat(40) },
      { headCycleId: RECORD_ID },
      { candidateFingerprint: `sha256:${"b".repeat(64)}` },
      { routeId: RECORD_ID },
      { adapter: "github_codex" },
      { dispatch: true },
      { install: true },
      { issueNumber: 9 },
      { merge: true },
    ]) {
      await expect(approveAcceptanceDependencyObservationAndMintExternalBuilderPack({
        ...valid,
        ...extra,
      } as never)).rejects.toThrow("requires exact workspace, Record, observation, and user actor");
    }
    for (const approvedBy of [
      USER_ID,
      `server:${USER_ID}`,
      "user:not-a-uuid",
      `user:${USER_ID}\u202e`,
    ]) {
      await expect(approveAcceptanceDependencyObservationAndMintExternalBuilderPack({
        ...valid,
        approvedBy,
      } as never)).rejects.toThrow("requires exact workspace, Record, observation, and user actor");
    }
  });

  it("accepts only workspace and Record on the current reader", async () => {
    for (const value of [
      { workspaceId: WORKSPACE_ID },
      { workspaceId: WORKSPACE_ID, recordId: "not-a-uuid" },
      { workspaceId: WORKSPACE_ID, recordId: RECORD_ID, headSha: "a".repeat(40) },
      { workspaceId: WORKSPACE_ID, recordId: RECORD_ID, observationEventId: OBSERVATION_EVENT_ID },
    ]) {
      await expect(readCurrentAcceptanceDependencyObservations(value as never))
        .rejects.toThrow("requires only workspace and Record");
    }
  });

  it("exposes a stable typed immutable-pair conflict", () => {
    const error = new AcceptanceDependencyExternalBuilderPackConflictError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AcceptanceDependencyExternalBuilderPackConflictError");
    expect(error.code).toBe("ACCEPTANCE_DEPENDENCY_EXTERNAL_BUILDER_PACK_CONFLICT");
  });
});

import { describe, expect, it } from "vitest";
import { parseAcceptanceDependencyObservationClaimInput } from "./acceptance_dependency_observation_work.js";

describe("parseAcceptanceDependencyObservationClaimInput", () => {
  it("admits only a tenant locator and bounded worker identity", () => {
    expect(parseAcceptanceDependencyObservationClaimInput({
      workspaceId: "11111111-1111-4111-8111-111111111111",
      workerId: "worker:r10-pnpm-1",
    })).toEqual({
      workspaceId: "11111111-1111-4111-8111-111111111111",
      workerId: "worker:r10-pnpm-1",
    });
    expect(parseAcceptanceDependencyObservationClaimInput({
      workspaceId: "11111111-1111-4111-8111-111111111111",
      workerId: "worker:r10-pnpm-1",
      recordId: "22222222-2222-4222-8222-222222222222",
    })).toBeNull();
    expect(parseAcceptanceDependencyObservationClaimInput({
      workspaceId: "11111111-1111-4111-8111-111111111111",
      workerId: " pnpm ",
    })).toBeNull();
  });
});

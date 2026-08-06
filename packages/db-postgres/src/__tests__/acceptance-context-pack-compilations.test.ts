import { describe, expect, it } from "vitest";
import { acceptanceContextPackCompilationId } from "../queries/change_records.js";

const binding = {
  recordId: "00000000-0000-0000-0000-000000000001",
  acceptanceContractId: "00000000-0000-0000-0000-000000000002",
  acceptanceContractVersion: 3,
  repositoryId: "00000000-0000-0000-0000-000000000003",
  phase: "execute",
};

describe("Acceptance Context Pack compilation identity", () => {
  it("is replay-stable for the same exact admission binding", () => {
    expect(acceptanceContextPackCompilationId(binding)).toBe(
      acceptanceContextPackCompilationId(binding)
    );
  });

  it("changes when a contract version, repository, or phase would change the worker input", () => {
    const id = acceptanceContextPackCompilationId(binding);
    expect(acceptanceContextPackCompilationId({ ...binding, acceptanceContractVersion: 4 })).not.toBe(id);
    expect(acceptanceContextPackCompilationId({ ...binding, repositoryId: "00000000-0000-0000-0000-000000000004" })).not.toBe(id);
    expect(acceptanceContextPackCompilationId({ ...binding, phase: "review" })).not.toBe(id);
  });
});

import { describe, expect, it } from "vitest";
import { runnerStepMode } from "./runner-step-helpers";

describe("runnerStepMode (#1281 AC1 — fresh workspace never sees an install form)", () => {
  it("a fresh workspace (hostedExecution default: connected=true, selfHosted=false) resolves to hosted-default, never no-execution-path", () => {
    // This is the exact signal shape every fresh workspace has today
    // (workspaces.hostedExecution defaults true, no self-hosted runner ever
    // attached) — hosted-default is the ONLY mode that keeps the
    // device-code form collapsed behind a disclosure. If this ever resolved
    // to "no-execution-path" instead, a fresh workspace would see the
    // install form unconditionally again.
    expect(runnerStepMode(true, false)).toBe("hosted-default");
    expect(runnerStepMode(true, false)).not.toBe("no-execution-path");
  });

  it("a self-hosted runner takes priority over hosted execution", () => {
    expect(runnerStepMode(true, true)).toBe("self-hosted-connected");
  });

  it("self-hosted alone (connected only via the runner, not hosted execution) is still self-hosted-connected", () => {
    expect(runnerStepMode(false, true)).toBe("self-hosted-connected");
  });

  it("no execution path at all falls back to no-execution-path (form shown directly)", () => {
    expect(runnerStepMode(false, false)).toBe("no-execution-path");
  });

  it("is total and deterministic over all four boolean combinations", () => {
    const cases: Array<[boolean, boolean]> = [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ];
    for (const [connected, selfHosted] of cases) {
      const a = runnerStepMode(connected, selfHosted);
      const b = runnerStepMode(connected, selfHosted);
      expect(a).toBe(b);
      expect(["self-hosted-connected", "hosted-default", "no-execution-path"]).toContain(a);
    }
  });
});

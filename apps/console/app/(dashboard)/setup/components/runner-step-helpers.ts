/**
 * Pure branch-selection for the setup wizard's runner/execution step (#1281
 * Q6 — "relocate visually"). Split out of `runner-step.tsx` so the
 * hosted-vs-self-host-vs-no-execution decision is unit-testable without a
 * DOM, mirroring `channel-step-helpers.ts`.
 */

export type RunnerStepMode =
  /** A self-hosted runner is actively polling — compact "connected" state,
   * no form (unchanged from before #1281). */
  | "self-hosted-connected"
  /** No self-hosted runner, but the workspace has an execution path via
   * hosted execution (the default for every fresh workspace). Compact
   * "Done — hosted execution is on" state; the device-code form moves
   * behind a "Self-hosting? Attach your own runner" disclosure, hidden by
   * default (#1281 AC1 — a fresh workspace never sees an install form). */
  | "hosted-default"
  /** Neither hosted execution nor a self-hosted runner — genuinely no
   * execution path yet. The device-code form renders directly,
   * unconditionally: there's no "done" state to collapse behind a
   * disclosure. Unreachable for a fresh workspace today (`hostedExecution`
   * defaults `true`), reachable only if a workspace explicitly disables
   * hosted execution before attaching a runner. */
  | "no-execution-path";

/** Which of the three RunnerStep branches should render, from the same
 * `connected`/`selfHosted` signals the step already receives. */
export function runnerStepMode(
  connected: boolean,
  selfHosted: boolean
): RunnerStepMode {
  if (selfHosted) return "self-hosted-connected";
  if (connected) return "hosted-default";
  return "no-execution-path";
}

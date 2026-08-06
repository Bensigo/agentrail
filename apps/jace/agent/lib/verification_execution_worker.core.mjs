import { verificationExecutionPrompt } from "./verification_execution_prompt.mjs";

/** Isolated claim -> constrained QA turn -> evidence-bound completion loop. */
export function createVerificationExecutionWorker({ claim, execute, complete, intervalMs = 10_000, log = () => {} }) {
  let inFlight = false;
  let timer = null;
  const completeSafely = async (input) => { try { await complete(input); } catch (error) { log("verification-execution completion failed", error); } };
  async function tick() {
    if (inFlight) return "idle";
    inFlight = true;
    try {
      const item = await claim();
      if (!item) return "idle";
      const plan = item.plan ?? item;
      if ((plan.modality ?? "ui") === "ui" && (!Array.isArray(plan.uiSteps) || plan.uiSteps.length === 0)) {
        await completeSafely({ executionId: item.execution.id, workerId: item.workerId, status: "not_testable", resultReason: "Planned UI criterion has no persisted safe uiSteps action list" });
        return "not_testable";
      }
      if (!item.previewUrl) {
        await completeSafely({ executionId: item.execution.id, workerId: item.workerId, status: "not_testable", resultReason: "No safe preview matched the exact PR head" });
        return "not_testable";
      }
      let result;
      try { result = await execute(verificationExecutionPrompt(item)); } catch (error) {
        await completeSafely({ executionId: item.execution.id, workerId: item.workerId, status: "failed", resultReason: error instanceof Error ? error.message : String(error) });
        return "failed";
      }
      const status = result?.status;
      const artifactIds = Array.isArray(result?.artifactIds) ? result.artifactIds.filter((id) => typeof id === "string" && id) : [];
      const observedBehavior = typeof result?.observedBehavior === "string" ? result.observedBehavior : null;
      const resultReason = typeof result?.reason === "string" ? result.reason : null;
      if (status === "proven" && observedBehavior && artifactIds.length) {
        await completeSafely({ executionId: item.execution.id, workerId: item.workerId, status, observedBehavior, artifactIds, resultReason });
        return "proven";
      }
      await completeSafely({ executionId: item.execution.id, workerId: item.workerId, status: status === "not_testable" ? "not_testable" : "not_proven", observedBehavior, artifactIds, resultReason: resultReason ?? "QA did not return evidence-bound proof" });
      return status === "not_testable" ? "not_testable" : "not_proven";
    } catch (error) { log("verification-execution worker failed", error); return "failed"; } finally { inFlight = false; }
  }
  return { tick, start() { if (timer === null) timer = setInterval(() => { tick(); }, intervalMs); }, stop() { if (timer !== null) { clearInterval(timer); timer = null; } } };
}

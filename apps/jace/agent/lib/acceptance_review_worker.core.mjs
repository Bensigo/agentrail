/**
 * Isolated exact-head Acceptance Review loop. This owns no model, browser, or
 * repository access: those belong to an injected bounded evaluator. A failed
 * evaluator never becomes a fabricated review result; its lease is recovered
 * by the Console queue policy.
 */
export function createAcceptanceReviewWorker({ claim, review, complete, intervalMs = 10_000, log = () => {} }) {
  if (typeof claim !== "function" || typeof review !== "function" || typeof complete !== "function") {
    throw new TypeError("claim, review, and complete are required");
  }
  let inFlight = false;
  let timer = null;

  async function tick() {
    if (inFlight) return "idle";
    inFlight = true;
    try {
      const item = await claim();
      if (!item) return "idle";
      if (!item.request?.id || !item.workerId) {
        log("acceptance-review worker received an invalid claim");
        return "failed";
      }
      let result;
      try {
        result = await review(item);
      } catch (error) {
        log("acceptance-review evaluator failed", error);
        return "failed";
      }
      if (!result || typeof result !== "object") {
        log("acceptance-review evaluator returned no completion payload");
        return "failed";
      }
      await complete({
        ...result,
        reviewRequestId: item.request.id,
        workerId: item.workerId,
        workspaceId: item.request.workspaceId,
        recordId: item.request.recordId,
        prRevisionId: item.request.prRevisionId,
        headSha: item.request.headSha,
        contractId: item.request.acceptanceContractId,
        contractVersion: item.request.acceptanceContractVersion,
      });
      return typeof result.overallStatus === "string" ? result.overallStatus : "completed";
    } catch (error) {
      log("acceptance-review worker failed", error);
      return "failed";
    } finally {
      inFlight = false;
    }
  }

  return {
    tick,
    start() {
      if (timer === null) timer = setInterval(() => { void tick(); }, intervalMs);
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

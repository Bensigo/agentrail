export function createContextPackRegenerationWorker({
  claim,
  execute,
  renew,
  intervalMs = 30_000,
  renewIntervalMs = 30_000,
  setTimer = setTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  let stopped = false;
  let inFlight = false;
  async function runOnce() {
    if (stopped || inFlight) return null;
    inFlight = true;
    try {
      const lease = await claim();
      if (!lease) return null;
      if (!renew) return await execute(lease);
      let renewing = false;
      let renewalError = null;
      const timer = setIntervalFn(async () => {
        if (renewing || renewalError) return;
        renewing = true;
        try { await renew(lease); }
        catch (error) { renewalError = error; }
        finally { renewing = false; }
      }, renewIntervalMs);
      try {
        const result = await execute(lease);
        if (renewalError) throw renewalError;
        return result;
      } finally {
        clearIntervalFn(timer);
      }
    } finally { inFlight = false; }
  }
  async function loop() {
    while (!stopped) {
      try { await runOnce(); } catch (error) {
        if (error?.fatal === true) throw error;
        /* lease expiry and bounded attempts fail closed in Console */
      }
      if (!stopped) await new Promise((resolve) => setTimer(resolve, intervalMs));
    }
  }
  return { runOnce, start: loop, stop: () => { stopped = true; } };
}

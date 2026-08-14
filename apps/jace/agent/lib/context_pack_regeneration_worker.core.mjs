export function createContextPackRegenerationWorker({ claim, execute, intervalMs = 30_000, setTimer = setTimeout }) {
  let stopped = false;
  let inFlight = false;
  async function runOnce() {
    if (stopped || inFlight) return null;
    inFlight = true;
    try {
      const lease = await claim();
      return lease ? await execute(lease) : null;
    } finally { inFlight = false; }
  }
  async function loop() {
    while (!stopped) {
      try { await runOnce(); } catch { /* lease expiry and bounded attempts fail closed in Console */ }
      if (!stopped) await new Promise((resolve) => setTimer(resolve, intervalMs));
    }
  }
  return { runOnce, start: loop, stop: () => { stopped = true; } };
}

/** Bounded SSE connection: one read at a time, no queued snapshots for slow clients. */
export function officeStream<T extends { tasks: unknown; observedAt: string }>({
  signal,
  authorized,
  read,
  intervalMs = 2000,
  lifetimeMs = 50000,
}: {
  signal: AbortSignal;
  authorized: () => Promise<boolean>;
  read: () => Promise<T>;
  intervalMs?: number;
  lifetimeMs?: number;
}) {
  const encoder = new TextEncoder();
  let stop = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let ended = false,
        timer: ReturnType<typeof setTimeout> | undefined;
      let previous = "";
      const finish = (closeController = true) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        clearTimeout(deadline);
        signal.removeEventListener("abort", close);
        if (closeController) controller.close();
      };
      const close = () => finish();
      const deadline = setTimeout(close, lifetimeMs);
      stop = () => finish(false);
      signal.addEventListener("abort", close, { once: true });
      const emit = (event: string, data: unknown) => {
        if (!ended && (controller.desiredSize ?? 0) > 0)
          controller.enqueue(
            encoder.encode(
              `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
            ),
          );
      };
      const tick = async () => {
        try {
          if (ended) return;
          if (!(await authorized())) {
            close();
            return;
          }
          if (ended) return;
          const snapshot = await read();
          if (ended) return;
          const fingerprint = JSON.stringify(snapshot.tasks);
          if ((controller.desiredSize ?? 0) > 0) {
            emit(
              fingerprint === previous ? "heartbeat" : "snapshot",
              fingerprint === previous
                ? { observedAt: snapshot.observedAt }
                : snapshot,
            );
            previous = fingerprint;
          }
        } catch {
          close();
          return;
        }
        if (!ended) timer = setTimeout(() => void tick(), intervalMs);
      };
      if (signal.aborted) close();
      else void tick();
    },
    cancel() {
      stop();
    },
  });
}

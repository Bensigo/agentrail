import { afterEach, describe, it, expect, vi } from "vitest";
import { officeStream } from "./office-stream";
afterEach(() => vi.useRealTimers());
const flush = async () => {
  await vi.advanceTimersByTimeAsync(0);
};
const decode = (x: ReadableStreamReadResult<Uint8Array>) =>
  new TextDecoder().decode(x.value);
describe("Office live stream", () => {
  it("sends changed snapshots and heartbeats, then stops on credential revocation", async () => {
    vi.useFakeTimers();
    const auth = vi.fn().mockResolvedValue(true),
      read = vi
        .fn()
        .mockResolvedValue({
          tasks: [{ id: "tenant-a", revision: 1 }],
          observedAt: "one",
        });
    const stream = officeStream({
        signal: new AbortController().signal,
        authorized: auth,
        read,
      }),
      reader = stream.getReader();
    const first = reader.read();
    await flush();
    expect(decode(await first)).toContain("event: snapshot");
    const ping = reader.read();
    await vi.advanceTimersByTimeAsync(2000);
    expect(decode(await ping)).toContain("event: heartbeat");
    read.mockResolvedValue({
      tasks: [{ id: "tenant-a", revision: 2 }],
      observedAt: "two",
    });
    const changed = reader.read();
    await vi.advanceTimersByTimeAsync(2000);
    expect(decode(await changed)).toContain('"revision":2');
    auth.mockResolvedValue(false);
    const end = reader.read();
    await vi.advanceTimersByTimeAsync(2000);
    expect((await end).done).toBe(true);
    expect(read).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not buffer unbounded snapshots for a slow reader and cancels cleanly", async () => {
    vi.useFakeTimers();
    const stream = officeStream({
      signal: new AbortController().signal,
      authorized: async () => true,
      read: async () => ({ tasks: [Date.now()], observedAt: "now" }),
    });
    await vi.advanceTimersByTimeAsync(20000);
    const reader = stream.getReader();
    expect(decode(await reader.read())).toContain("event: snapshot");
    await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("closes on abort/deadline, including an in-flight database read", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    let resolve!: (v: { tasks: never[]; observedAt: string }) => void;
    const read = vi.fn(
      () =>
        new Promise<{ tasks: never[]; observedAt: string }>((r) => {
          resolve = r;
        }),
    );
    const reader = officeStream({
      signal: abort.signal,
      authorized: async () => true,
      read,
    }).getReader();
    await flush();
    abort.abort();
    expect((await reader.read()).done).toBe(true);
    resolve({ tasks: [], observedAt: "late" });
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    const bounded = officeStream({
      signal: new AbortController().signal,
      authorized: async () => true,
      read: async () => ({ tasks: [], observedAt: "now" }),
    }).getReader();
    await flush();
    await bounded.read();
    await vi.advanceTimersByTimeAsync(50000);
    await bounded.read();
    expect((await bounded.read()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

import { describe, it, expect } from "vitest";
import { OfficeSimulation, walkable, desk } from "./office-simulation";
import type { OfficeTask } from "./office-model";
const now = Date.parse("2026-11-09T12:00:00Z");
const task = (overrides: Partial<OfficeTask> = {}): OfficeTask => ({
  id: "a",
  agent: "Agent",
  title: "Real work",
  branch: "main",
  phase: "implementing",
  summary: "Building",
  revision: 1,
  repository_name: "owner/repo",
  updated_at: new Date(now).toISOString(),
  reported_at: new Date(now).toISOString(),
  reported_phase: "implementing",
  context_at: null,
  usage_at: null,
  context: null,
  usage: null,
  ...overrides,
});
const advance = (sim: OfficeSimulation, seconds: number, clock = now) => {
  for (let n = 0; n < seconds * 20; n++) sim.advance(0.05, clock);
};
describe("continuous Office simulation", () => {
  it("walks around furniture to the assigned desk and stays inside the room", () => {
    const sim = new OfficeSimulation();
    sim.reconcile([task()], now);
    const actor = sim.actors.get("a")!,
      start = { x: actor.x, y: actor.y };
    advance(sim, 2);
    expect(Math.hypot(actor.x - start.x, actor.y - start.y)).toBeGreaterThan(
      50,
    );
    for (let n = 0; n < 1400; n++) {
      sim.advance(0.05, now);
      expect(walkable(actor, sim.items, sim.height)).toBe(true);
    }
    expect(actor.station).toBe("Work desk");
    expect(actor.action).toBe("Working at desk");
    expect(Math.abs(actor.x - (desk(0).x + desk(0).w / 2))).toBeLessThan(25);
  });
  it("reroutes immediately on reported phase changes without teleporting", () => {
    const sim = new OfficeSimulation();
    sim.reconcile([task()], now);
    advance(sim, 15);
    const a = sim.actors.get("a")!,
      before = { x: a.x, y: a.y };
    sim.reconcile(
      [task({ revision: 2, phase: "testing", reported_phase: "testing" })],
      now,
    );
    expect({ x: a.x, y: a.y }).toEqual(before);
    expect(a.station).toBe("Testing station");
    advance(sim, 25);
    expect(a.action).toBe("Checking work");
    expect(a.x).toBeGreaterThan(700);
  });
  it("uses idle/waiting behavior for stale reports and human reopen, keeping their metrics intact", () => {
    const sim = new OfficeSimulation();
    const stale = task({ reported_at: new Date(now - 180000).toISOString() });
    sim.reconcile([stale], now);
    expect(sim.actors.get("a")?.station).toBe("Lounge");
    advance(sim, 15);
    const a = sim.actors.get("a")!,
      x = a.x;
    advance(sim, 20);
    expect(a.gait).toBeGreaterThan(0);
    expect(a.task).toBe(stale);
    expect(a.x).not.toBe(x);
    sim.reconcile(
      [
        task({
          revision: 2,
          phase: "planning",
          reported_phase: "needs_review",
        }),
      ],
      now,
    );
    expect(a.station).toBe("Lounge");
  });
  it("animates real shared context visits and closed session departures", () => {
    const sim = new OfficeSimulation();
    sim.reconcile(
      [
        task({
          context: {
            summary: "Shared files",
            sources: ["src/work.ts"],
            tokens: null,
            windowTokens: null,
          },
        }),
      ],
      now,
    );
    let visited = false;
    for (let n = 0; n < 1000; n++) {
      sim.advance(0.05, now);
      if (sim.actors.get("a")?.station === "Context break") visited = true;
    }
    expect(visited).toBe(true);
    sim.reconcile([task({ revision: 2, phase: "closed" })], now);
    expect(sim.actors.get("a")?.action).toBe("Leaving the office");
    advance(sim, 13);
    expect(sim.actors.size).toBe(0);
  });
  it("keeps the room grid and current route for telemetry-only reports", () => {
    const sim = new OfficeSimulation();
    sim.reconcile([task()], now);
    advance(sim, 1);
    const items = sim.items,
      path = sim.actors.get("a")!.route;
    sim.reconcile(
      [
        task({
          revision: 2,
          usage_at: new Date(now).toISOString(),
          usage: { costUsd: 0, inputTokens: 0, outputTokens: null },
        }),
      ],
      now,
    );
    expect(sim.items).toBe(items);
    expect(sim.actors.get("a")!.route).toBe(path);
    expect(sim.actors.get("a")!.bubble).toBe("Reported cost $0.00");
  });
  it("removes departing avatars immediately in reduced motion", () => {
    const sim = new OfficeSimulation();
    sim.reconcile([task()], now);
    sim.settle(now);
    sim.reconcile([task({ revision: 2, phase: "closed" })], now);
    sim.settle(now);
    expect(sim.actors.size).toBe(0);
    sim.reconcile([task({ id: "new" })], now);
    sim.settle(now);
    expect(sim.actors.get("new")?.slot).toBe(0);
  });
  it("settles for reduced motion and handles a full cohort without invalid paths", () => {
    const sim = new OfficeSimulation();
    sim.reconcile(
      Array.from({ length: 100 }, (_, n) =>
        task({
          id: String(n),
          phase: [
            "planning",
            "implementing",
            "testing",
            "reviewing",
            "needs_review",
          ][n % 5],
        }),
      ),
      now,
    );
    expect(sim.actors.size).toBe(100);
    expect(sim.height).toBeGreaterThan(4000);
    sim.settle(now);
    for (const a of sim.actors.values()) {
      expect(a.route).toEqual([]);
      expect(a.moving).toBe(false);
      expect(walkable(a, sim.items, sim.height)).toBe(true);
    }
  });
});

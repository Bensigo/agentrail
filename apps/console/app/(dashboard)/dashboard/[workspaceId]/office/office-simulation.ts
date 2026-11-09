import { recentlyReporting, usd, type OfficeTask } from "./office-model";
export interface Point {
  x: number;
  y: number;
}
export interface Furniture {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: "desk" | "library" | "test" | "review" | "sofa";
}
export interface SimActor extends Point {
  id: string;
  task: OfficeTask;
  slot: number;
  route: Point[];
  station: string;
  action: string;
  nextAction: number;
  gait: number;
  moving: boolean;
  bubble: string;
  bubbleUntil: number;
  departAt: number | null;
  direction: number;
}
export const WORLD_WIDTH = 960;
const CELL = 24;
const hash = (s: string) =>
  Array.from(s).reduce((n, c) => (Math.imul(n, 31) + c.charCodeAt(0)) >>> 0, 7);
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
export function roomHeight(count: number) {
  return Math.max(640, Math.ceil(Math.max(6, count) / 3) * 145 + 240);
}
export function desk(slot: number): Furniture {
  return {
    x: 126 + (slot % 3) * 182,
    y: 178 + Math.floor(slot / 3) * 145,
    w: 126,
    h: 54,
    kind: "desk",
  };
}
export function furniture(count: number): Furniture[] {
  return [
    ...Array.from({ length: Math.max(6, count) }, (_, n) => desk(n)),
    { x: 105, y: 56, w: 430, h: 42, kind: "library" },
    { x: 720, y: 100, w: 168, h: 55, kind: "test" },
    { x: 731, y: 293, w: 124, h: 76, kind: "review" },
    { x: 700, y: 471, w: 160, h: 48, kind: "sofa" },
  ];
}
export function walkable(p: Point, items: Furniture[], height: number) {
  return (
    p.x > 30 &&
    p.x < WORLD_WIDTH - 30 &&
    p.y > 26 &&
    p.y < height - 24 &&
    !items.some(
      (b) =>
        p.x > b.x - 17 &&
        p.x < b.x + b.w + 17 &&
        p.y > b.y - 17 &&
        p.y < b.y + b.h + 17,
    )
  );
}
// Geometry is immutable for a room layout; all actors share its occupancy grid.
const navigation = new WeakMap<
  Furniture[],
  { height: number; free: Uint8Array; cols: number; rows: number }
>();
/** Four-way grid routing keeps people out of furniture, with bounded breadth-first search. */
export function route(
  start: Point,
  target: Point,
  items: Furniture[],
  height: number,
): Point[] {
  let grid = navigation.get(items);
  if (!grid || grid.height !== height) {
    const cols = Math.ceil(WORLD_WIDTH / CELL),
      rows = Math.ceil(height / CELL),
      free = new Uint8Array(cols * rows);
    for (let n = 0; n < free.length; n++)
      free[n] = Number(
        walkable(
          {
            x: (n % cols) * CELL + CELL / 2,
            y: Math.floor(n / cols) * CELL + CELL / 2,
          },
          items,
          height,
        ),
      );
    grid = { height, free, cols, rows };
    navigation.set(items, grid);
  }
  const { cols, rows, free } = grid,
    point = (n: number) => ({
      x: (n % cols) * CELL + CELL / 2,
      y: Math.floor(n / cols) * CELL + CELL / 2,
    });
  const nearest = (p: Point) => {
    const x = Math.max(0, Math.min(cols - 1, Math.floor(p.x / CELL))),
      y = Math.max(0, Math.min(rows - 1, Math.floor(p.y / CELL)));
    for (let radius = 0; radius < Math.max(cols, rows); radius++) {
      let best = -1,
        score = Infinity;
      for (let dy = -radius; dy <= radius; dy++)
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
          const nx = x + dx,
            ny = y + dy,
            n = ny * cols + nx;
          if (nx < 0 || nx >= cols || ny < 0 || ny >= rows || !free[n])
            continue;
          const d = distance(p, point(n));
          if (d < score) {
            best = n;
            score = d;
          }
        }
      if (best >= 0) return best;
    }
    return -1;
  };
  const from = nearest(start),
    to = nearest(target);
  if (from < 0 || to < 0) return [];
  const previous = new Int32Array(free.length).fill(-2),
    queue = new Int32Array(free.length);
  previous[from] = -1;
  queue[0] = from;
  let length = 1;
  for (let head = 0; head < length; head++) {
    const current = queue[head];
    if (current === to) break;
    for (const next of [
      current - 1,
      current + 1,
      current - cols,
      current + cols,
    ]) {
      if (
        next < 0 ||
        next >= free.length ||
        previous[next] !== -2 ||
        Math.abs((next % cols) - (current % cols)) > 1 ||
        !free[next]
      )
        continue;
      previous[next] = current;
      queue[length++] = next;
    }
  }
  if (previous[to] === -2) return [];
  const path: Point[] = [];
  for (let n = to; n !== -1; n = previous[n]) path.push(point(n));
  return path.reverse();
}
export class OfficeSimulation {
  actors = new Map<string, SimActor>();
  elapsed = 0;
  height = 640;
  items: Furniture[] = furniture(6);
  private slots = new Map<string, number>();
  reconcile(tasks: OfficeTask[], now: number) {
    const active = tasks.filter((t) => t.phase !== "closed"),
      ids = new Set(active.map((t) => t.id));
    for (const [id, a] of this.actors) {
      if (!ids.has(id) && a.departAt === null) {
        a.task = tasks.find((t) => t.id === id) || a.task;
        a.departAt = this.elapsed + 12;
        this.move(a, { x: 60, y: 548 }, "Exit", "Leaving the office");
      }
    }
    for (const task of active) {
      if (!this.slots.has(task.id)) {
        const used = new Set(this.slots.values());
        let slot = 0;
        while (used.has(slot)) slot++;
        this.slots.set(task.id, slot);
      }
    }
    const count = Math.max(6, ...Array.from(this.slots.values(), (n) => n + 1));
    const layoutChanged = this.items.length !== count + 4;
    if (layoutChanged) {
      this.height = roomHeight(count);
      this.items = furniture(count);
    }
    for (const task of active) {
      let a = this.actors.get(task.id);
      if (!a) {
        const slot = this.slots.get(task.id)!;
        a = {
          id: task.id,
          task,
          slot,
          x: 60 + (slot % 2) * 22,
          y: 548 + (slot % 3) * 20,
          route: [],
          station: "Entry",
          action: "Arriving",
          nextAction: this.elapsed + slot * 0.2,
          gait: 0,
          moving: false,
          bubble: "",
          bubbleUntil: 0,
          departAt: null,
          direction: 1,
        };
        this.actors.set(task.id, a);
        this.assign(a, now);
        continue;
      }
      const previous = a.task,
        changed = task.revision > previous.revision;
      a.task = task;
      a.departAt = null;
      if (changed) {
        a.bubble =
          task.context_at !== previous.context_at && task.context
            ? `Context: ${task.context.sources[0] || task.context.summary}`
            : task.usage_at !== previous.usage_at && task.usage?.costUsd != null
              ? `Reported cost ${usd(task.usage.costUsd)}`
              : task.summary;
        a.bubbleUntil = this.elapsed + 6;
      }
      if (
        layoutChanged ||
        (a.station !== this.station(task, now) &&
          !(
            a.station === "Context break" &&
            this.station(task, now) === "Work desk"
          ))
      )
        this.assign(a, now);
    }
  }
  private station(task: OfficeTask, now: number) {
    if (task.phase === "blocked") return "Help desk";
    if (task.phase === "needs_review") return "Waiting for review";
    if (!recentlyReporting(task, now)) return "Lounge";
    return task.phase === "planning"
      ? "Context library"
      : task.phase === "testing"
        ? "Testing station"
        : task.phase === "reviewing"
          ? "Review table"
          : "Work desk";
  }
  private destination(a: SimActor, station: string): Point {
    const n = a.slot,
      b = desk(n);
    if (station === "Work desk") return { x: b.x + b.w / 2, y: b.y + 83 };
    if (station === "Context library")
      return { x: 144 + (n % 10) * 34, y: 132 + Math.floor(n / 10) * 32 };
    if (station === "Testing station")
      return { x: 733 + (n % 4) * 37, y: 207 + Math.floor(n / 4) * 31 };
    if (station === "Review table" || station === "Help desk")
      return { x: n % 2 ? 884 : 690, y: 313 + (Math.floor(n / 2) % 5) * 37 };
    return { x: 687 + (n % 6) * 34, y: 558 + Math.floor(n / 6) * 32 };
  }
  private move(a: SimActor, target: Point, station: string, action: string) {
    a.station = station;
    a.action = action;
    a.route = route(a, target, this.items, this.height);
    a.moving = a.route.length > 0;
  }
  private assign(a: SimActor, now: number) {
    const station = this.station(a.task, now);
    this.move(
      a,
      this.destination(a, station),
      station,
      `Walking to ${station.toLowerCase()}`,
    );
    a.nextAction = this.elapsed + 9 + (hash(a.id) % 8);
  }
  advance(seconds: number, now: number) {
    const dt = Math.min(0.1, Math.max(0, seconds));
    this.elapsed += dt;
    for (const [id, a] of this.actors) {
      if (a.departAt !== null && this.elapsed > a.departAt) {
        this.actors.delete(id);
        this.slots.delete(id);
        continue;
      }
      const desired = this.station(a.task, now);
      if (
        a.departAt === null &&
        desired !== a.station &&
        !(a.station === "Context break" && desired === "Work desk")
      )
        this.assign(a, now);
      let travel = dt * (59 + (hash(a.id) % 15));
      a.moving = a.route.length > 0;
      while (travel > 0 && a.route.length) {
        const target = a.route[0],
          d = distance(a, target);
        if (d <= travel) {
          a.x = target.x;
          a.y = target.y;
          a.route.shift();
          travel -= d;
        } else {
          const dx = (target.x - a.x) / d,
            dy = (target.y - a.y) / d;
          a.x += dx * travel;
          a.y += dy * travel;
          if (Math.abs(dx) > 0.1) a.direction = dx > 0 ? 1 : -1;
          travel = 0;
        }
      }
      a.gait += dt * (a.moving ? 12 : 2);
      if (a.moving && !a.route.length) {
        a.nextAction = this.elapsed + 8 + (hash(a.id) % 9);
        a.action =
          a.station === "Work desk"
            ? "Working at desk"
            : a.station === "Testing station"
              ? "Checking work"
              : a.station === "Context library" || a.station === "Context break"
                ? "Reading shared context"
                : a.station === "Review table"
                  ? "Reviewing work"
                  : a.station === "Help desk"
                    ? "Waiting for help"
                    : a.station === "Waiting for review"
                      ? "Waiting for your review"
                      : "Idle · awaiting an update";
      }
      if (!a.route.length && a.departAt !== null) {
        this.actors.delete(id);
        this.slots.delete(id);
        continue;
      }
      if (!a.route.length && this.elapsed > a.nextAction) {
        if (
          desired === "Work desk" &&
          a.task.context &&
          a.station !== "Context break"
        )
          this.move(
            a,
            this.destination(a, "Context library"),
            "Context break",
            "Walking through shared context",
          );
        else if (a.station === "Context break") this.assign(a, now);
        else if (
          desired === "Lounge" ||
          desired === "Waiting for review" ||
          desired === "Help desk"
        ) {
          const p = this.destination(a, desired),
            offset = (Math.floor(this.elapsed / 10) + a.slot) % 2 ? 28 : -28;
          this.move(
            a,
            { x: p.x + offset, y: p.y },
            desired,
            desired === "Lounge"
              ? "Idle · taking a short walk"
              : "Waiting · stretching legs",
          );
        }
        a.nextAction = this.elapsed + 10 + (hash(a.id) % 8);
      }
    }
  }
  settle(now: number) {
    for (const a of this.actors.values()) {
      if (a.departAt !== null) {
        this.actors.delete(a.id);
        this.slots.delete(a.id);
        continue;
      }
      if (a.station !== this.station(a.task, now)) this.assign(a, now);
      const last = a.route.at(-1);
      if (last) {
        a.x = last.x;
        a.y = last.y;
      }
      a.route = [];
      a.moving = false;
      a.gait = 0;
      a.action = a.station;
    }
  }
  hit(p: Point, radius = 24) {
    return Array.from(this.actors.values())
      .filter((a) => distance(a, p) < radius)
      .sort((a, b) => distance(a, p) - distance(b, p))[0];
  }
}
const round = (
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r = 5,
) => {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
};
function text(
  c: CanvasRenderingContext2D,
  s: string,
  x: number,
  y: number,
  size = 11,
  color = "#555e4c",
  align: CanvasTextAlign = "left",
) {
  c.font = `${size}px ui-monospace, SFMono-Regular, monospace`;
  c.textAlign = align;
  c.fillStyle = color;
  c.fillText(s, x, y);
}
export function drawRoom(c: CanvasRenderingContext2D, sim: OfficeSimulation) {
  c.fillStyle = "#e9eae2";
  c.fillRect(0, 0, WORLD_WIDTH, sim.height);
  c.strokeStyle = "#daddd1";
  c.lineWidth = 0.6;
  for (let x = 24; x < WORLD_WIDTH; x += 32) {
    c.beginPath();
    c.moveTo(x, 0);
    c.lineTo(x, sim.height);
    c.stroke();
  }
  for (let y = 24; y < sim.height; y += 32) {
    c.beginPath();
    c.moveTo(0, y);
    c.lineTo(WORLD_WIDTH, y);
    c.stroke();
  }
  c.strokeStyle = "#c8cdbf";
  c.lineWidth = 15;
  c.strokeRect(8, 8, WORLD_WIDTH - 16, sim.height - 16);
  c.fillStyle = "#e9eae2";
  c.fillRect(0, 521, 20, 66);
  text(c, "ENTRY", 34, 606, 10, "#68715c");
  c.fillStyle = "#d7e4dd";
  for (let x = 590; x < 880; x += 90) {
    c.fillRect(x, 3, 70, 10);
    c.strokeStyle = "#adbfb5";
    c.strokeRect(x, 3, 70, 10);
  }
  text(c, "CONTEXT LIBRARY", 110, 37, 11);
  text(c, "WORKSPACE", 126, 158, 11);
  text(c, "TESTING", 728, 78, 11);
  text(c, "REVIEW / HELP", 710, 270, 11);
  text(c, "WAITING LOUNGE", 705, 448, 11);
  for (const f of sim.items) {
    c.fillStyle = "#46513b12";
    round(c, f.x + 2, f.y + 5, f.w, f.h);
    c.fill();
    c.fillStyle =
      f.kind === "sofa"
        ? "#acb89b"
        : f.kind === "library"
          ? "#c2b89c"
          : f.kind === "review"
            ? "#d8cdb2"
            : "#f6f3e7";
    c.strokeStyle = "#b3bba6";
    round(c, f.x, f.y, f.w, f.h, f.kind === "review" ? 30 : 7);
    c.fill();
    c.stroke();
    if (f.kind === "desk" || f.kind === "test") {
      c.fillStyle = "#364032";
      round(c, f.x + f.w / 2 - 26, f.y + 8, 52, 27, 3);
      c.fill();
      c.fillStyle = "#8ea36f";
      c.fillRect(f.x + f.w / 2 - 20, f.y + 14, 30, 3);
      c.fillRect(f.x + f.w / 2 - 20, f.y + 21, 38, 2);
      c.fillStyle = "#c9cec0";
      round(c, f.x + f.w / 2 - 22, f.y + 40, 44, 7, 2);
      c.fill();
      c.fillStyle = "#c8b895";
      c.beginPath();
      c.arc(f.x + f.w - 14, f.y + 15, 5, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = "#aab59d";
      round(c, f.x + f.w / 2 - 18, f.y + 70, 36, 25, 10);
      c.fill();
    }
    if (f.kind === "library") {
      for (let x = f.x + 10; x < f.x + f.w - 10; x += 16) {
        c.fillStyle = ["#8d9b79", "#a9977b", "#8faaa7", "#c6bb7a"][
          Math.floor(x / 16) % 4
        ];
        c.fillRect(x, f.y + 7, 11, f.h - 14);
      }
    }
    if (f.kind === "review") {
      c.fillStyle = "#faf9ed";
      c.save();
      c.translate(f.x + 30, f.y + 19);
      c.rotate(0.15);
      c.fillRect(0, 0, 23, 30);
      c.restore();
      c.fillStyle = "#b1a27e";
      c.beginPath();
      c.arc(f.x + 91, f.y + 33, 7, 0, Math.PI * 2);
      c.fill();
    }
    if (f.kind === "sofa") {
      c.strokeStyle = "#929f80";
      for (let x = f.x + 12; x < f.x + f.w - 15; x += 36) {
        round(c, x, f.y + 7, 32, f.h - 14, 4);
        c.stroke();
      }
    }
  }
  for (const p of [
    { x: 60, y: 60 },
    { x: 910, y: 430 },
    { x: 610, y: 90 },
  ]) {
    c.fillStyle = "#b7a787";
    c.beginPath();
    c.arc(p.x, p.y, 13, 0, 7);
    c.fill();
    for (let n = 0; n < 5; n++) {
      c.save();
      c.translate(p.x, p.y);
      c.rotate(n * 1.3);
      c.fillStyle = n % 2 ? "#829468" : "#9aa982";
      c.beginPath();
      c.ellipse(9, 0, 15, 7, 0.4, 0, 7);
      c.fill();
      c.restore();
    }
  }
}
export function drawActors(
  c: CanvasRenderingContext2D,
  sim: OfficeSimulation,
  selected: string,
  hovered: string,
  animate: boolean,
) {
  const colors = ["#dcc656", "#8faa89", "#94aeb9", "#baa0bc", "#ca9e76"];
  for (const a of Array.from(sim.actors.values()).sort((x, y) => x.y - y.y)) {
    const walking = animate && a.moving,
      phase = animate ? a.gait : 0,
      bob = walking
        ? Math.sin(phase * 2) * 1.3
        : animate
          ? Math.sin(phase) * 0.65
          : 0;
    c.save();
    c.translate(a.x, a.y);
    c.fillStyle = "#38402b20";
    c.beginPath();
    c.ellipse(0, 11, 14, 5, 0, 0, 7);
    c.fill();
    if (a.id === selected) {
      c.strokeStyle = "#b5a132";
      c.lineWidth = 2;
      c.beginPath();
      c.ellipse(0, 9, 18, 9, 0, 0, 7);
      c.stroke();
    }
    c.translate(0, bob);
    c.strokeStyle = "#525c48";
    c.lineWidth = 5;
    c.lineCap = "round";
    const stride = walking ? Math.sin(phase) * 5 : 0;
    c.beginPath();
    c.moveTo(-5, 5);
    c.lineTo(-5 + stride, 15);
    c.moveTo(5, 5);
    c.lineTo(5 - stride, 15);
    c.stroke();
    c.fillStyle = colors[hash(a.id) % colors.length];
    round(c, -11, -13, 22, 23, 7);
    c.fill();
    c.strokeStyle = c.fillStyle;
    c.lineWidth = 5;
    c.beginPath();
    c.moveTo(-9, -8);
    c.lineTo(-14, walking ? stride - 3 : Math.sin(phase * 3) * 1.2 - 1);
    c.moveTo(9, -8);
    c.lineTo(14, walking ? -stride - 3 : Math.sin(phase * 3 + 1) * 1.2 - 1);
    c.stroke();
    c.fillStyle = "#c6a184";
    c.beginPath();
    c.arc(0, -19, 8, 0, 7);
    c.fill();
    c.fillStyle = "#444a3b";
    c.beginPath();
    c.ellipse(0, -22, 8, 5, 0, Math.PI, Math.PI * 2);
    c.fill();
    c.fillStyle = "#404737";
    if (animate && Math.sin(phase * 0.7) > 0.96) {
      c.fillRect(-4, -19, 3, 1);
      c.fillRect(2, -19, 3, 1);
    } else {
      c.fillRect(-3, -20, 1.4, 2);
      c.fillRect(3, -20, 1.4, 2);
    }
    c.restore();
    const label =
      a.task.agent.length > 19 ? a.task.agent.slice(0, 18) + "…" : a.task.agent;
    c.fillStyle = a.id === selected ? "#fffdf2ee" : "#f8f8f0e8";
    round(
      c,
      a.x - label.length * 3.4 - 7,
      a.y + 21,
      label.length * 6.8 + 14,
      20,
      4,
    );
    c.fill();
    text(c, label, a.x, a.y + 35, 11, "#3e4936", "center");
    if (a.id === selected || a.id === hovered || a.bubbleUntil > sim.elapsed) {
      const message = (
          a.bubbleUntil > sim.elapsed
            ? a.bubble
            : a.id === hovered
              ? a.task.title
              : a.action
        ).slice(0, 65),
        w = Math.min(360, Math.max(105, message.length * 5.8 + 22));
      c.fillStyle = "#fffef6f5";
      c.strokeStyle = "#bbc3ad";
      round(c, a.x - w / 2, a.y - 71, w, 27, 6);
      c.fill();
      c.stroke();
      text(
        c,
        message.length * 5.8 > w - 20
          ? message.slice(0, Math.floor((w - 25) / 5.8)) + "…"
          : message,
        a.x,
        a.y - 53,
        10,
        "#424d39",
        "center",
      );
    }
    if (a.task.phase === "needs_review" || a.task.phase === "blocked") {
      c.fillStyle = a.task.phase === "blocked" ? "#b67c60" : "#c5a53d";
      c.beginPath();
      c.arc(a.x + 13, a.y - 29, 6, 0, 7);
      c.fill();
      text(c, "!", a.x + 13, a.y - 26, 9, "#fff", "center");
    }
  }
}

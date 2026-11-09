"use client";
import { useEffect, useRef, useState } from "react";
import { Pause, Play, Scan, ZoomIn, ZoomOut, LocateFixed } from "lucide-react";
import {
  OfficeSimulation,
  WORLD_WIDTH,
  drawRoom,
  drawActors,
  type Point,
} from "./office-simulation";
import { phaseName, recentlyReporting, type OfficeTask } from "./office-model";
interface Props {
  tasks: OfficeTask[];
  selectedId: string;
  now: number;
  onSelect: (id: string) => void;
  showClosed: boolean;
}
export function OfficeScene({
  tasks,
  selectedId,
  now,
  onSelect,
  showClosed,
}: Props) {
  const canvas = useRef<HTMLCanvasElement | null>(null),
    simulation = useRef(new OfficeSimulation()),
    camera = useRef({ x: 0, y: 0, scale: 1, initialized: false }),
    clock = useRef({ server: now, client: 0 }),
    size = useRef({ w: 960, h: 540 }),
    selected = useRef(selectedId),
    select = useRef(onSelect),
    hover = useRef("");
  const draw = useRef<() => void>(() => {}),
    control = useRef<(action: string) => void>(() => {}),
    options = useRef({ paused: false, reduced: false }),
    [paused, setPaused] = useState(false),
    [reduced, setReduced] = useState(false),
    [activity, setActivity] = useState("Arriving"),
    [zoom, setZoom] = useState(100);
  selected.current = selectedId;
  select.current = onSelect;
  useEffect(() => {
    clock.current = { server: now, client: performance.now() };
  }, [now]);
  useEffect(() => {
    simulation.current.reconcile(tasks, now);
    if (options.current.reduced) simulation.current.settle(now);
    draw.current();
  }, [tasks, now]);
  useEffect(() => {
    options.current = { paused, reduced };
    if (reduced)
      simulation.current.settle(
        clock.current.server + performance.now() - clock.current.client,
      );
    draw.current();
  }, [paused, reduced]);
  useEffect(() => {
    control.current("selected");
    draw.current();
  }, [selectedId]);
  useEffect(() => {
    const node = canvas.current;
    if (!node) return;
    const ctx = node.getContext("2d");
    if (!ctx) return;
    let frame: number | null = null,
      last = performance.now(),
      lastStatus = 0,
      background: HTMLCanvasElement | null = null,
      backgroundKey = "",
      disposed = false;
    clock.current.client = performance.now();
    const sim = simulation.current,
      view = camera.current;
    const logicalNow = () =>
      clock.current.server + performance.now() - clock.current.client;
    const center = (p: Point) => {
      view.x = size.current.w / 2 - p.x * view.scale;
      view.y = size.current.h / 2 - p.y * view.scale;
    };
    const fit = () => {
      view.scale =
        Math.min(size.current.w / WORLD_WIDTH, size.current.h / sim.height) *
        0.96;
      center({ x: WORLD_WIDTH / 2, y: sim.height / 2 });
      setZoom(Math.round(view.scale * 100));
    };
    const zoomTo = (factor: number) => {
      const p = {
        x: (size.current.w / 2 - view.x) / view.scale,
        y: (size.current.h / 2 - view.y) / view.scale,
      };
      view.scale = Math.max(0.05, Math.min(2.4, view.scale * factor));
      center(p);
      setZoom(Math.round(view.scale * 100));
    };
    const schedule = () => {
      if (!disposed && frame === null && !document.hidden)
        frame = requestAnimationFrame(paint);
    };
    function paint(t: number) {
      frame = null;
      if (disposed) return;
      const running = !options.current.paused && !options.current.reduced;
      const dt = Math.max(0, (t - last) / 1000);
      last = t;
      if (running) sim.advance(dt, logicalNow());
      const key = `${sim.height}:${sim.items.length}`;
      if (!background || backgroundKey !== key) {
        background = document.createElement("canvas");
        background.width = WORLD_WIDTH;
        background.height = sim.height;
        const b = background.getContext("2d");
        if (b) drawRoom(b, sim);
        backgroundKey = key;
      }
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.fillStyle = "#dfe3d7";
      ctx!.fillRect(0, 0, size.current.w, size.current.h);
      ctx!.translate(view.x, view.y);
      ctx!.scale(view.scale, view.scale);
      ctx!.drawImage(background, 0, 0);
      drawActors(ctx!, sim, selected.current, hover.current, running);
      if (t - lastStatus > 400) {
        const a = sim.actors.get(selected.current);
        setActivity(a?.action || "No active session");
        lastStatus = t;
      }
      if (running) schedule();
    }
    draw.current = () => {
      last = performance.now();
      schedule();
    };
    control.current = (action) => {
      if (action === "fit") fit();
      else if (action === "in") zoomTo(1.2);
      else if (action === "out") zoomTo(1 / 1.2);
      else if (action === "selected") {
        const a = sim.actors.get(selected.current);
        if (a) center(a);
      }
      schedule();
    };
    const resize = () => {
      const rect = node.getBoundingClientRect();
      size.current = { w: rect.width, h: rect.height };
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      node.width = Math.round(rect.width * dpr);
      node.height = Math.round(rect.height * dpr);
      if (!view.initialized) {
        fit();
        if (rect.width < 600) {
          view.scale = Math.max(view.scale, 0.74);
          const a = sim.actors.get(selected.current);
          center(a || { x: 240, y: 350 });
          setZoom(Math.round(view.scale * 100));
        }
        view.initialized = true;
      }
      schedule();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    resize();
    const media = window.matchMedia("(prefers-reduced-motion: reduce)"),
      change = () => setReduced(media.matches);
    change();
    media.addEventListener("change", change);
    const visibility = () => {
      if (document.hidden) {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
      } else {
        last = performance.now();
        schedule();
      }
    };
    document.addEventListener("visibilitychange", visibility);
    let drag: {
      x: number;
      y: number;
      startX: number;
      startY: number;
      moving: boolean;
    } | null = null;
    const point = (e: PointerEvent) => {
      const r = node.getBoundingClientRect();
      return {
        x: (e.clientX - r.left - view.x) / view.scale,
        y: (e.clientY - r.top - view.y) / view.scale,
      };
    };
    const down = (e: PointerEvent) => {
      drag = {
        x: e.clientX,
        y: e.clientY,
        startX: e.clientX,
        startY: e.clientY,
        moving: false,
      };
      node.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (drag) {
        const dx = e.clientX - drag.x,
          dy = e.clientY - drag.y;
        if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 5)
          drag.moving = true;
        if (drag.moving) {
          view.x += dx;
          view.y += dy;
          schedule();
        }
        drag.x = e.clientX;
        drag.y = e.clientY;
      } else {
        hover.current =
          sim.hit(point(e), Math.max(20, 24 / view.scale))?.id || "";
        node.style.cursor = hover.current ? "pointer" : "grab";
        schedule();
      }
    };
    const up = (e: PointerEvent) => {
      if (drag && !drag.moving) {
        const a = sim.hit(point(e), Math.max(20, 24 / view.scale));
        if (a) select.current(a.id);
      }
      drag = null;
      if (node.hasPointerCapture(e.pointerId))
        node.releasePointerCapture(e.pointerId);
    };
    const leave = () => {
      hover.current = "";
      schedule();
    };
    const key = (e: KeyboardEvent) => {
      const actions: Record<string, () => void> = {
        ArrowLeft: () => {
          view.x += 35;
        },
        ArrowRight: () => {
          view.x -= 35;
        },
        ArrowUp: () => {
          view.y += 35;
        },
        ArrowDown: () => {
          view.y -= 35;
        },
        "+": () => zoomTo(1.2),
        "=": () => zoomTo(1.2),
        "-": () => zoomTo(1 / 1.2),
        Home: fit,
      };
      if (actions[e.key]) {
        e.preventDefault();
        actions[e.key]();
        schedule();
      }
    };
    node.addEventListener("pointerdown", down);
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointercancel", up);
    node.addEventListener("pointerleave", leave);
    node.addEventListener("keydown", key);
    schedule();
    return () => {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      media.removeEventListener("change", change);
      document.removeEventListener("visibilitychange", visibility);
      node.removeEventListener("pointerdown", down);
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", up);
      node.removeEventListener("pointercancel", up);
      node.removeEventListener("pointerleave", leave);
      node.removeEventListener("keydown", key);
      draw.current = () => {};
      control.current = () => {};
    };
  }, []);
  const visible = tasks.filter((t) => showClosed || t.phase !== "closed");
  return (
    <section
      id="office-floor"
      tabIndex={-1}
      className="office-scene"
      aria-label="Live office simulation"
    >
      <div className="office-scene-toolbar">
        <span>
          <i />
          {reduced
            ? "Reduced motion"
            : paused
              ? "Simulation paused"
              : "Simulation running"}
        </span>
        <div>
          <button
            onClick={() => setPaused((v) => !v)}
            disabled={reduced}
            aria-pressed={paused}
            aria-label={paused ? "Resume simulation" : "Pause simulation"}
          >
            {paused ? <Play size={14} /> : <Pause size={14} />}
          </button>
          <button onClick={() => control.current("out")} aria-label="Zoom out">
            <ZoomOut size={14} />
          </button>
          <span>{zoom}%</span>
          <button onClick={() => control.current("in")} aria-label="Zoom in">
            <ZoomIn size={14} />
          </button>
          <button
            onClick={() => control.current("fit")}
            aria-label="Fit office"
          >
            <Scan size={14} />
          </button>
          <button
            onClick={() => control.current("selected")}
            aria-label="Center selected agent"
          >
            <LocateFixed size={14} />
          </button>
        </div>
      </div>
      <canvas
        ref={canvas}
        width={960}
        height={540}
        className="office-live-canvas"
        role="img"
        tabIndex={0}
        aria-label="Animated agents walking and working in the office. Drag to pan, use arrow keys to move, or select a work session below."
      />
      <div className="office-scene-caption">
        <span>{activity}</span>
        <span>Drag to explore · movement is simulated</span>
      </div>
      <div className="office-agent-roster" aria-label="Work sessions">
        {visible.map((task) => (
          <button
            key={task.id}
            aria-pressed={selectedId === task.id}
            onClick={() => select.current(task.id)}
          >
            <span className={`office-status ${task.phase}`} />
            <strong>{task.agent}</strong>
            <span>
              {phaseName[task.phase] || task.phase}
              {recentlyReporting(task, now) ? " · recent report" : ""}
            </span>
          </button>
        ))}
      </div>
      {!visible.length && (
        <p className="office-scene-empty">
          No open work sessions. Start work through your MCP agent to bring
          someone into the office.
        </p>
      )}
    </section>
  );
}

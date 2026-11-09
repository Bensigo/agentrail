"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
  CirclePause,
  GitBranch,
  RefreshCw,
  Radio,
  Sparkles,
} from "lucide-react";
import {
  age,
  phaseName,
  recentlyReporting,
  usageSubtotal,
  usd,
  type OfficeSnapshot,
  type OfficeTask,
} from "./office-model";
import "./office.css";

function Desk({
  task,
  selected,
  recent,
  onSelect,
}: {
  task: OfficeTask;
  selected: boolean;
  recent: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      className={`office-desk ${selected ? "is-selected" : ""} ${recent ? "is-working" : ""} ${task.phase === "closed" ? "is-closed" : ""}`}
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`${task.agent}: ${task.title}, ${phaseName[task.phase] || task.phase}`}
    >
      <span className="office-desk-state">
        <i className={`office-status ${task.phase}`} />
        {phaseName[task.phase] || task.phase}
      </span>
      <svg viewBox="0 0 180 130" aria-hidden="true" className="office-desk-art">
        <ellipse
          cx="90"
          cy="109"
          rx="47"
          ry="8"
          fill="currentColor"
          opacity=".06"
        />
        <rect
          x="18"
          y="18"
          width="144"
          height="69"
          rx="12"
          fill="var(--desk-top)"
          stroke="var(--desk-line)"
        />
        <rect
          x="25"
          y="78"
          width="130"
          height="9"
          rx="4"
          fill="var(--desk-line)"
          opacity=".3"
        />
        <path
          d="M38 87v12m104-12v12"
          stroke="var(--desk-line)"
          strokeWidth="5"
          strokeLinecap="round"
        />
        <rect x="61" y="25" width="59" height="34" rx="4" fill="#333631" />
        <rect
          x="66"
          y="30"
          width="49"
          height="22"
          rx="1"
          fill={recent ? "#424c3a" : "#464842"}
        />
        <path
          d="M70 36h18m-18 5h31m-31 5h24"
          stroke={recent ? "#b3ce83" : "#7e8378"}
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          className="office-cursor"
          d="M100 46h5"
          stroke="#e8dc62"
          strokeWidth="2"
        />
        <path
          d="M90 59v6m-13 0h27"
          stroke="#777b70"
          strokeWidth="3"
          strokeLinecap="round"
        />
        <rect x="69" y="69" width="42" height="10" rx="3" fill="#d4d7ce" />
        <path
          d="M73 73h33"
          stroke="#a4a99d"
          strokeWidth="2"
          strokeDasharray="2 2"
        />
        <rect
          x="38"
          y="39"
          width="14"
          height="21"
          rx="2"
          fill="#eeeee6"
          transform="rotate(-8 38 39)"
        />
        <path d="M41 45h7m-7 4h6m-6 4h5" stroke="#b4b7a9" strokeWidth="1.5" />
        <circle cx="140" cy="40" r="7" fill="#d9caa9" />
        <circle cx="140" cy="40" r="4" fill="#7b6650" />
        <rect x="65" y="91" width="51" height="31" rx="14" fill="#697365" />
        <g className="office-person">
          <path
            d="M72 96c0-14 36-14 36 0v12H72z"
            fill={selected ? "#e3cb40" : "#c6c6b8"}
          />
          <path
            d="M74 91l-8-11m40 11 8-11"
            stroke={selected ? "#e3cb40" : "#c6c6b8"}
            strokeWidth="9"
            strokeLinecap="round"
          />
          <ellipse cx="90" cy="84" rx="13" ry="14" fill="#bb9879" />
          <path d="M77 83c-3-18 29-22 27 0-6-5-20-7-27 0" fill="#47483c" />
        </g>
      </svg>
      <span className="office-desk-label">
        <strong>{task.agent}</strong>
        <span>{task.title}</span>
      </span>
      <span className="office-desk-cost">
        {task.usage?.costUsd != null
          ? `${usd(task.usage.costUsd)} reported`
          : "Cost not reported"}
      </span>
    </button>
  );
}
function Plant({ className = "" }: { className?: string }) {
  return (
    <span className={`office-plant ${className}`} aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
      <b />
    </span>
  );
}

export function Office({
  workspaceId,
  initial,
}: {
  workspaceId: string;
  initial: OfficeSnapshot;
}) {
  const [snapshot, setSnapshot] = useState(initial),
    [selectedId, setSelectedId] = useState(initial.tasks[0]?.id || ""),
    [now, setNow] = useState(() => new Date(initial.observedAt).getTime()),
    [error, setError] = useState(""),
    [refreshing, setRefreshing] = useState(false),
    [showClosed, setShowClosed] = useState(false);
  const observed = useRef({
    server: new Date(initial.observedAt).getTime(),
    client: Date.now(),
  });
  const inspector = useRef<HTMLElement | null>(null);
  const request = useRef(0),
    controller = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    const version = ++request.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setRefreshing(true);
    try {
      const response = await fetch(
        `/api/v1/workflow/office?workspaceId=${workspaceId}`,
        { cache: "no-store", signal: abort.signal },
      );
      if (!response.ok) throw new Error("Console unavailable");
      const data: OfficeSnapshot = await response.json();
      if (version !== request.current) return;
      setSnapshot((previous) =>
        new Date(data.observedAt).getTime() <
        new Date(previous.observedAt).getTime()
          ? previous
          : data,
      );
      observed.current = {
        server: new Date(data.observedAt).getTime(),
        client: Date.now(),
      };
      setNow(observed.current.server);
      setError("");
    } catch (e) {
      if (version === request.current && !abort.signal.aborted)
        setError(e instanceof Error ? e.message : "Updates unavailable");
    } finally {
      if (version === request.current) setRefreshing(false);
    }
  }, [workspaceId]);
  useEffect(() => {
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 10000);
    const clock = setInterval(
      () =>
        setNow(observed.current.server + Date.now() - observed.current.client),
      10000,
    );
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
      document.removeEventListener("visibilitychange", visible);
      request.current++;
      controller.current?.abort();
    };
  }, [refresh]);
  const visible = snapshot.tasks.filter(
    (t) => showClosed || t.phase !== "closed",
  );
  const selected = visible.find((t) => t.id === selectedId) || visible[0];
  const totals = usageSubtotal(visible),
    recent = snapshot.tasks.filter((t) => recentlyReporting(t, now)).length,
    waiting = snapshot.tasks.filter((t) => t.phase === "needs_review").length;
  return (
    <div className="office-view">
      <header className="office-heading">
        <div>
          <div className="office-eyebrow">AGENTRAIL / WORKSPACE</div>
          <h1>
            Office
            <span className="office-heading-dot" />
          </h1>
          <p>Select a desk to inspect a work session.</p>
        </div>
        <div className="office-refresh">
          <span>
            <Radio size={13} />
            {error ? "Updates unavailable" : "Updates every 10s"}
          </span>
          <button
            onClick={() => void refresh()}
            aria-label="Refresh office"
            disabled={refreshing}
          >
            <RefreshCw size={15} className={refreshing ? "office-spin" : ""} />
          </button>
        </div>
      </header>
      <div className="office-summary">
        <span>
          <b>{recent}</b> recent active reports
        </span>
        <span>
          <b>{waiting}</b> need review
        </span>
        <span>
          <b>{totals.known ? usd(totals.usd) : "—"}</b> reported cost{" "}
          <small>
            {totals.unknown ? `· ${totals.unknown} unreported` : ""}
          </small>
        </span>
        <label>
          <input
            type="checkbox"
            checked={showClosed}
            onChange={(e) => setShowClosed(e.target.checked)}
          />
          Show closed
        </label>
      </div>
      {error && (
        <p role="status" className="office-error">
          {error}. Showing the last saved reports.
        </p>
      )}
      <div className="office-layout">
        <section
          id="office-floor"
          tabIndex={-1}
          className="office-floor"
          aria-label="Office floor plan"
        >
          <div className="office-floor-top">
            <span>
              <i />
              FLOOR 01
            </span>
            <span>
              {visible.length} work session{visible.length !== 1 ? "s" : ""}
            </span>
          </div>
          <div className="office-room">
            <div className="office-windows" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <Plant className="office-plant-top" />
            <div className="office-work-area">
              <div className="office-area-label">WORKSPACE</div>
              {visible.length ? (
                <div className="office-desks">
                  {visible.map((task) => (
                    <Desk
                      key={task.id}
                      task={task}
                      selected={selected?.id === task.id}
                      recent={recentlyReporting(task, now)}
                      onSelect={() => {
                        setSelectedId(task.id);
                        if (window.matchMedia("(max-width: 760px)").matches)
                          requestAnimationFrame(() => {
                            inspector.current?.focus({ preventScroll: true });
                            inspector.current?.scrollIntoView({
                              block: "start",
                              behavior: window.matchMedia(
                                "(prefers-reduced-motion: reduce)",
                              ).matches
                                ? "auto"
                                : "smooth",
                            });
                          });
                      }}
                    />
                  ))}
                </div>
              ) : (
                <div className="office-empty">
                  <div className="office-empty-desks" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </div>
                  <h2>
                    {snapshot.tasks.length
                      ? "Work is wrapped up"
                      : "Your office is ready"}
                  </h2>
                  <p>
                    {snapshot.tasks.length
                      ? "Show closed sessions to revisit their history."
                      : "Connect your coding agent and start a task to take a desk."}
                  </p>
                  <Link
                    href={`/dashboard/${workspaceId}/${snapshot.tasks.length ? "work" : "agents"}`}
                  >
                    {snapshot.tasks.length ? "View work" : "Connect an agent"}
                    <ArrowUpRight size={14} />
                  </Link>
                </div>
              )}
            </div>
            <div className="office-lounge" aria-hidden="true">
              <div className="office-sofa">
                <i />
                <i />
                <i />
              </div>
              <span className="office-coffee-table" />
              <Plant />
              <span className="office-lounge-label">COMMON ROOM</span>
            </div>
          </div>
          <div className="office-floor-bottom">
            <span>
              <i className="office-status implementing" />
              Recent agent report
            </span>
            <span>
              <CirclePause size={12} />
              Quiet / waiting
            </span>
          </div>
        </section>
        <aside
          ref={inspector}
          tabIndex={-1}
          className="office-inspector"
          aria-label="Selected work session"
        >
          <a className="office-back" href="#office-floor">
            ↑ Back to desks
          </a>
          {selected ? (
            <>
              <div className="office-inspector-heading">
                <span className="office-avatar">
                  {selected.agent.slice(0, 2).toUpperCase()}
                </span>
                <div>
                  <h2>{selected.agent}</h2>
                  <span>
                    {recentlyReporting(selected, now)
                      ? "Recent report"
                      : "Last agent report"}{" "}
                    · {age(selected.reported_at, now)}
                  </span>
                </div>
              </div>
              <div className="office-inspector-section">
                <span className={`office-phase ${selected.phase}`}>
                  <i className={`office-status ${selected.phase}`} />
                  {phaseName[selected.phase] || selected.phase}
                </span>
                <h3>{selected.title}</h3>
                <p className="office-task-summary">
                  {selected.summary || "Planning the next step."}
                </p>
                <div className="office-branch">
                  <GitBranch size={13} />
                  <span>{selected.branch}</span>
                </div>
                <Link
                  className="office-detail-link"
                  href={`/dashboard/${workspaceId}/work/${selected.id}`}
                >
                  Open task history
                  <ArrowUpRight size={13} />
                </Link>
              </div>
              <div className="office-inspector-section">
                <div className="office-section-title">
                  <BookOpen size={14} />
                  <h3>Context</h3>
                  <span>{age(selected.context_at, now)}</span>
                </div>
                {selected.context ? (
                  <>
                    <p className="office-context-summary">
                      {selected.context.summary}
                    </p>
                    {selected.context.tokens !== null &&
                    selected.context.windowTokens !== null ? (
                      <>
                        <div
                          className="office-context-meter"
                          role="progressbar"
                          aria-label="Reported context window"
                          aria-valuemin={0}
                          aria-valuemax={selected.context.windowTokens}
                          aria-valuenow={Math.min(
                            selected.context.tokens,
                            selected.context.windowTokens,
                          )}
                        >
                          <i
                            style={{
                              width: `${Math.min(100, (selected.context.tokens / selected.context.windowTokens) * 100)}%`,
                            }}
                          />
                        </div>
                        <p className="office-context-count">
                          {selected.context.tokens.toLocaleString("en-US")} /{" "}
                          {selected.context.windowTokens.toLocaleString(
                            "en-US",
                          )}{" "}
                          reported tokens
                        </p>
                      </>
                    ) : (
                      <p className="office-muted">
                        Context window not reported
                      </p>
                    )}
                    <ul className="office-source-list">
                      {selected.context.sources.map((source, i) => (
                        <li key={`${source}-${i}`}>{source}</li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="office-muted">
                    No context snapshot shared yet.
                  </p>
                )}
              </div>
              <div className="office-inspector-section">
                <div className="office-section-title">
                  <Sparkles size={14} />
                  <h3>Cost & usage</h3>
                  <span>{age(selected.usage_at, now)}</span>
                </div>
                <div className="office-cost-value">
                  {selected.usage?.costUsd != null
                    ? usd(selected.usage.costUsd)
                    : "—"}
                </div>
                <p className="office-muted">
                  {selected.usage?.costUsd != null
                    ? "Reported cumulative task cost"
                    : "Cost not reported"}
                </p>
                <dl className="office-token-counts">
                  <div>
                    <dt>Input tokens</dt>
                    <dd>
                      {selected.usage?.inputTokens?.toLocaleString("en-US") ??
                        "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>Output tokens</dt>
                    <dd>
                      {selected.usage?.outputTokens?.toLocaleString("en-US") ??
                        "—"}
                    </dd>
                  </div>
                </dl>
              </div>
              <p className="office-provenance">
                Agent-reported context and usage. MCP cannot read your agent’s
                private context or billing automatically.
              </p>
            </>
          ) : (
            <div className="office-inspector-empty">
              <BookOpen size={25} />
              <h2>No desk selected</h2>
              <p>
                Task, context and usage details appear here when your agent
                reports work.
              </p>
            </div>
          )}
        </aside>
      </div>
      <footer className="office-footnote">
        <span>One desk per task. Agent names are reported labels.</span>
        <span>
          Up to {snapshot.limit} tasks, open first · costs cover displayed
          sessions
        </span>
      </footer>
    </div>
  );
}

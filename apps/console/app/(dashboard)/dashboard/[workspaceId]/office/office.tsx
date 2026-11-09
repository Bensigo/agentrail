"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
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
import { OfficeScene } from "./office-scene";
import "./office.css";

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
    [live, setLive] = useState(false),
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
    let source: EventSource | null = null,
      connected = false;
    const connect = () => {
      source?.close();
      connected = false;
      setLive(false);
      if (document.hidden) return;
      source = new EventSource(
        `/api/v1/workflow/office/events?workspaceId=${workspaceId}`,
      );
      source.onopen = () => {
        connected = true;
        setLive(true);
        setError("");
      };
      source.onerror = () => {
        connected = false;
        setLive(false);
      };
      source.addEventListener("snapshot", (event) => {
        const data: OfficeSnapshot = JSON.parse((event as MessageEvent).data);
        ++request.current;
        controller.current?.abort();
        setRefreshing(false);
        setSnapshot((previous) =>
          Date.parse(data.observedAt) < Date.parse(previous.observedAt)
            ? previous
            : data,
        );
        observed.current = {
          server: Date.parse(data.observedAt),
          client: Date.now(),
        };
        setNow(observed.current.server);
        setError("");
      });
      source.addEventListener("heartbeat", (event) => {
        const data = JSON.parse((event as MessageEvent).data);
        observed.current = {
          server: Date.parse(data.observedAt),
          client: Date.now(),
        };
      });
    };
    connect();
    const poll = setInterval(() => {
      if (!document.hidden && !connected) void refresh();
    }, 5000);
    const clock = setInterval(
      () =>
        setNow(observed.current.server + Date.now() - observed.current.client),
      1000,
    );
    document.addEventListener("visibilitychange", connect);
    return () => {
      source?.close();
      clearInterval(poll);
      clearInterval(clock);
      document.removeEventListener("visibilitychange", connect);
      request.current++;
      controller.current?.abort();
    };
  }, [refresh, workspaceId]);
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
          <p>
            Watch your agents move through the office. Select one to inspect its
            work.
          </p>
        </div>
        <div className="office-refresh">
          <span>
            <Radio size={13} />
            {error
              ? "Updates unavailable"
              : live
                ? "Live updates"
                : "Reconnecting · polling"}
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
        <OfficeScene
          tasks={snapshot.tasks}
          selectedId={selected?.id || ""}
          now={now}
          showClosed={showClosed}
          onSelect={(id) => {
            setSelectedId(id);
            if (snapshot.tasks.find((t) => t.id === id)?.phase === "closed")
              setShowClosed(true);
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
        <aside
          ref={inspector}
          tabIndex={-1}
          className="office-inspector"
          aria-label="Selected work session"
        >
          <a className="office-back" href="#office-floor">
            ↑ Back to office
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

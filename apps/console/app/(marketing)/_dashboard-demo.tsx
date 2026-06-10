"use client";

import { useState } from "react";

const ACCENT = "#ffe629";

type ViewKey =
  | "Runs"
  | "Context packs"
  | "Review gates"
  | "Failures"
  | "Costs"
  | "Memory"
  | "Audit"
  | "Repos";

const NAV: ViewKey[] = [
  "Runs",
  "Context packs",
  "Review gates",
  "Failures",
  "Costs",
  "Memory",
  "Audit",
  "Repos",
];

const SLUG: Record<ViewKey, string> = {
  Runs: "runs",
  "Context packs": "context-packs",
  "Review gates": "review-gates",
  Failures: "failures",
  Costs: "costs",
  Memory: "memory",
  Audit: "audit",
  Repos: "repos",
};

const STAT_TILES: Record<ViewKey, { v: string; l: string; accent?: boolean }[]> = {
  Runs: [
    { v: "128", l: "runs this week" },
    { v: "2.1M", l: "tokens" },
    { v: "$31.40", l: "spend" },
    { v: "3", l: "open gates", accent: true },
  ],
  "Context packs": [
    { v: "412", l: "packs built" },
    { v: "−24%", l: "tokens vs files", accent: true },
    { v: "L-ranges", l: "not whole files" },
    { v: "100%", l: "cited" },
  ],
  "Review gates": [
    { v: "9", l: "gates configured" },
    { v: "3", l: "open now", accent: true },
    { v: "147", l: "passed" },
    { v: "12", l: "blocked" },
  ],
  Failures: [
    { v: "6", l: "this week" },
    { v: "4", l: "root-caused" },
    { v: "2", l: "open", accent: true },
    { v: "0", l: "recurring" },
  ],
  Costs: [
    { v: "$31.40", l: "this week" },
    { v: "$1,284", l: "this month" },
    { v: "2.1M", l: "tokens" },
    { v: "$0.41", l: "avg / run" },
  ],
  Memory: [
    { v: "38", l: "items" },
    { v: "12", l: "recalled / wk", accent: true },
    { v: "4", l: "kinds" },
    { v: "0", l: "repeated mistakes" },
  ],
  Audit: [
    { v: "1,902", l: "events" },
    { v: "23", l: "sensitive", accent: true },
    { v: "100%", l: "source-linked" },
    { v: "0", l: "gaps" },
  ],
  Repos: [
    { v: "7", l: "repositories" },
    { v: "6", l: "healthy" },
    { v: "1", l: "indexing", accent: true },
    { v: "303", l: "sources" },
  ],
};

const statusStyle: Record<string, { dot: string; label: string }> = {
  merged: { dot: "var(--green-11)", label: "merged" },
  reviewing: { dot: ACCENT, label: "review gate" },
  failed: { dot: "var(--red-11)", label: "failed" },
  running: { dot: "var(--blue-11)", label: "running" },
};

const runs = [
  { id: "#312", task: "workspace setup flow", who: "amara", agent: "claude", status: "merged", tk: "31,092", cost: "$0.42" },
  { id: "#316", task: "AFK telemetry timeline", who: "deniz", agent: "codex", status: "reviewing", tk: "48,210", cost: "$0.71" },
  { id: "#331", task: "review-gate enforcement", who: "amara", agent: "claude", status: "merged", tk: "27,540", cost: "$0.38" },
  { id: "#314", task: "workspace members by email", who: "sam", agent: "claude", status: "failed", tk: "12,800", cost: "$0.18" },
  { id: "#315", task: "agentrail link e2e", who: "deniz", agent: "codex", status: "running", tk: "19,430", cost: "$0.29" },
];

const packs = [
  { f: "lib/response.js", l: "L142–L168", r: "symbol definition" },
  { f: "lib/request.js", l: "L88–L101", r: "graph expansion" },
  { f: "test/res.json.js", l: "L12–L40", r: "BM25 keyword match" },
  { f: "lib/models.js", l: "L210–L233", r: "import neighbor" },
];

const gates = [
  { name: "tests-pass", run: "#312", state: "passed" },
  { name: "context-evidence", run: "#316", state: "open" },
  { name: "no-secret-write", run: "#331", state: "passed" },
  { name: "human-approval", run: "#314", state: "blocked" },
];

const gateStyle: Record<string, { dot: string; label: string }> = {
  passed: { dot: "var(--green-11)", label: "passed" },
  open: { dot: ACCENT, label: "awaiting evidence" },
  blocked: { dot: "var(--red-11)", label: "blocked" },
};

const failures = [
  { title: "stale embedding hash drops vectors", run: "#316", cause: "config-hash mismatch" },
  { title: "migration 0008 silently skipped", run: "#331", cause: "journal timestamp order" },
  { title: "members page key warning", run: "#314", cause: "API contract mismatch" },
];

const costRows = [
  { repo: "bensigo/agentrail", pct: 64, v: "$20.1" },
  { repo: "psf/requests", pct: 22, v: "$6.9" },
  { repo: "acme/api", pct: 14, v: "$4.4" },
];

const memory = [
  { t: "Drizzle migrations need a journal entry", k: "reference" },
  { t: "AFK bases worktrees on origin/main", k: "project" },
  { t: "Default to lexical+graph retrieval", k: "decision" },
];

const audit = [
  { ts: "14:02:11", action: "context pack served", who: "claude · #312" },
  { ts: "14:02:48", action: "secret redacted", who: "engine" },
  { ts: "14:03:20", action: "review gate opened", who: "#316" },
  { ts: "14:05:02", action: "provider call", who: "anthropic" },
];

const repos = [
  { name: "bensigo/agentrail", branch: "main", health: "healthy" },
  { name: "psf/requests", branch: "main", health: "healthy" },
  { name: "acme/api", branch: "develop", health: "indexing" },
];

const repoHealth: Record<string, string> = {
  healthy: "var(--green-11)",
  indexing: ACCENT,
  critical: "var(--red-11)",
};

function Th({ children }: { children: React.ReactNode }) {
  return (
    <div className="hidden border-b border-[var(--gray-04)] bg-[var(--gray-02)] px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-[var(--gray-09)] sm:grid">
      {children}
    </div>
  );
}

function Panel({ view }: { view: ViewKey }) {
  if (view === "Runs") {
    return (
      <div className="overflow-hidden rounded-lg border border-[var(--gray-05)]">
        <div className="hidden grid-cols-[64px_1fr_92px_96px_72px] gap-2 border-b border-[var(--gray-04)] bg-[var(--gray-02)] px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-[var(--gray-09)] sm:grid">
          <span>run</span><span>task</span><span>status</span><span>tokens</span><span>cost</span>
        </div>
        {runs.map((r) => {
          const st = statusStyle[r.status];
          return (
            <div
              key={r.id}
              className="grid grid-cols-[64px_1fr_92px] items-center gap-2 border-b border-[var(--gray-04)] px-3 py-2.5 last:border-0 sm:grid-cols-[64px_1fr_92px_96px_72px]"
            >
              <span className="font-mono text-[12px]" style={{ color: ACCENT }}>{r.id}</span>
              <span className="min-w-0">
                <span className="block truncate text-[12.5px] text-[var(--gray-12)]">{r.task}</span>
                <span className="font-mono text-[10px] text-[var(--gray-09)]">{r.who} · {r.agent}</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: st.dot }} />
                <span className="text-[11px]" style={{ color: st.dot }}>{st.label}</span>
              </span>
              <span className="hidden font-mono text-[12px] text-[var(--gray-11)] sm:block">{r.tk}</span>
              <span className="hidden font-mono text-[12px] text-[var(--gray-11)] sm:block">{r.cost}</span>
            </div>
          );
        })}
      </div>
    );
  }

  if (view === "Context packs") {
    return (
      <div className="space-y-2">
        <p className="font-mono text-[11px] text-[var(--gray-09)]">
          Pack for run <span style={{ color: ACCENT }}>#312</span> — bounded line ranges, each with a reason.
        </p>
        {packs.map((p) => (
          <div key={p.f} className="flex items-center gap-3 rounded-md border border-[var(--gray-05)] bg-[var(--gray-00)]/60 px-3 py-2">
            <span className="font-mono text-[12px] text-[var(--gray-12)]">{p.f}</span>
            <span className="font-mono text-[12px]" style={{ color: ACCENT }}>{p.l}</span>
            <span className="ml-auto font-mono text-[11px] text-[var(--gray-09)]">{p.r}</span>
          </div>
        ))}
      </div>
    );
  }

  if (view === "Review gates") {
    return (
      <div className="overflow-hidden rounded-lg border border-[var(--gray-05)]">
        <Th><div className="grid grid-cols-[1fr_64px_140px] gap-2"><span>gate</span><span>run</span><span>status</span></div></Th>
        {gates.map((g) => {
          const st = gateStyle[g.state];
          return (
            <div key={g.name} className="grid grid-cols-[1fr_64px_140px] items-center gap-2 border-b border-[var(--gray-04)] px-3 py-2.5 last:border-0">
              <span className="font-mono text-[12.5px] text-[var(--gray-12)]">{g.name}</span>
              <span className="font-mono text-[12px]" style={{ color: ACCENT }}>{g.run}</span>
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: st.dot }} />
                <span className="text-[11px]" style={{ color: st.dot }}>{st.label}</span>
              </span>
            </div>
          );
        })}
      </div>
    );
  }

  if (view === "Failures") {
    return (
      <div className="space-y-2">
        {failures.map((f) => (
          <div key={f.title} className="rounded-md border border-[var(--gray-05)] bg-[var(--gray-00)]/60 px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12.5px] text-[var(--gray-12)]">{f.title}</span>
              <span className="font-mono text-[11px]" style={{ color: ACCENT }}>{f.run}</span>
            </div>
            <span className="mt-1 inline-block rounded border border-[var(--gray-05)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--gray-09)]">
              root cause: {f.cause}
            </span>
          </div>
        ))}
      </div>
    );
  }

  if (view === "Costs") {
    return (
      <div className="space-y-3">
        {costRows.map((c) => (
          <div key={c.repo}>
            <div className="flex items-center justify-between text-[12px]">
              <span className="font-mono text-[var(--gray-11)]">{c.repo}</span>
              <span className="font-mono text-[var(--gray-12)]">{c.v}</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-[var(--gray-03)]">
              <div className="h-full rounded-full" style={{ width: `${c.pct}%`, background: ACCENT }} />
            </div>
          </div>
        ))}
        <p className="pt-1 font-mono text-[11px] text-[var(--gray-09)]">Token + dollar spend per repo, team, and workspace.</p>
      </div>
    );
  }

  if (view === "Memory") {
    return (
      <div className="space-y-2">
        {memory.map((m) => (
          <div key={m.t} className="flex items-center gap-3 rounded-md border border-[var(--gray-05)] bg-[var(--gray-00)]/60 px-3 py-2.5">
            <span className="text-[12.5px] text-[var(--gray-12)]">{m.t}</span>
            <span className="ml-auto rounded-full border border-[var(--gray-05)] px-2 py-0.5 font-mono text-[10px] text-[var(--gray-09)]">{m.k}</span>
          </div>
        ))}
      </div>
    );
  }

  if (view === "Audit") {
    return (
      <div className="overflow-hidden rounded-lg border border-[var(--gray-05)] font-mono">
        {audit.map((a) => (
          <div key={a.ts} className="grid grid-cols-[72px_1fr_auto] items-center gap-3 border-b border-[var(--gray-04)] px-3 py-2 last:border-0 text-[11.5px]">
            <span className="text-[var(--gray-09)]">{a.ts}</span>
            <span className="text-[var(--gray-12)]">{a.action}</span>
            <span className="text-[var(--gray-09)]">{a.who}</span>
          </div>
        ))}
      </div>
    );
  }

  // Repos
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--gray-05)]">
      <Th><div className="grid grid-cols-[1fr_96px_110px] gap-2"><span>repository</span><span>branch</span><span>health</span></div></Th>
      {repos.map((r) => (
        <div key={r.name} className="grid grid-cols-[1fr_96px_110px] items-center gap-2 border-b border-[var(--gray-04)] px-3 py-2.5 last:border-0">
          <span className="font-mono text-[12.5px] text-[var(--gray-12)]">{r.name}</span>
          <span className="font-mono text-[11px] text-[var(--gray-09)]">{r.branch}</span>
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: repoHealth[r.health] }} />
            <span className="text-[11px] text-[var(--gray-11)]">{r.health}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

export function DashboardDemo() {
  const [view, setView] = useState<ViewKey>("Runs");

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--gray-05)] bg-[var(--gray-01)] shadow-[0_40px_120px_-40px_rgba(0,0,0,0.8)]">
      {/* window chrome */}
      <div className="flex items-center gap-2 border-b border-[var(--gray-04)] bg-[var(--gray-02)] px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-[var(--gray-06)]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[var(--gray-06)]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[var(--gray-06)]" />
        <span className="ml-3 rounded bg-[var(--gray-00)] px-3 py-1 font-mono text-[11px] text-[var(--gray-09)]">
          app.agentrail.dev/dashboard/dev-workspace/{SLUG[view]}
        </span>
        <span className="ml-auto hidden font-mono text-[10px] uppercase tracking-wider text-[var(--gray-08)] sm:inline">
          live demo · click around ↓
        </span>
      </div>

      <div className="grid grid-cols-[180px_1fr]">
        {/* sidebar */}
        <aside className="hidden border-r border-[var(--gray-04)] bg-[var(--gray-01)] p-3 sm:block">
          <div className="mb-3 flex items-center gap-2 rounded-md border border-[var(--gray-05)] px-2.5 py-2">
            <span className="flex h-5 w-5 items-center justify-center rounded text-[11px] font-bold text-black" style={{ background: ACCENT }}>D</span>
            <span className="text-[12px] font-semibold text-[var(--gray-12)]">Dev Workspace</span>
          </div>
          <nav className="space-y-0.5">
            {NAV.map((label) => {
              const active = label === view;
              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => setView(label)}
                  className="block w-full rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-[var(--gray-02)]"
                  style={{
                    background: active ? "color-mix(in srgb, #ffe629 12%, transparent)" : "transparent",
                    color: active ? ACCENT : "var(--gray-10)",
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  {label}
                </button>
              );
            })}
          </nav>
        </aside>

        {/* main */}
        <div className="p-4 sm:p-5">
          {/* contextual stat tiles */}
          <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            {STAT_TILES[view].map((s) => (
              <div key={s.l} className="rounded-lg border border-[var(--gray-05)] bg-[var(--gray-00)]/60 px-3 py-2.5">
                <p className="text-[18px] font-bold tracking-tight" style={{ color: s.accent ? ACCENT : "var(--gray-12)" }}>
                  {s.v}
                </p>
                <p className="font-mono text-[10px] uppercase tracking-wider text-[var(--gray-09)]">{s.l}</p>
              </div>
            ))}
          </div>

          {/* mobile view switcher (sidebar is desktop-only) */}
          <div className="mb-3 flex gap-1.5 overflow-x-auto sm:hidden">
            {NAV.map((label) => (
              <button
                key={label}
                type="button"
                onClick={() => setView(label)}
                className="shrink-0 rounded-full border px-2.5 py-1 text-[11px] transition-colors"
                style={{
                  borderColor: label === view ? ACCENT : "var(--gray-05)",
                  color: label === view ? ACCENT : "var(--gray-10)",
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <Panel view={view} />
        </div>
      </div>
    </div>
  );
}

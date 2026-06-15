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
    { v: "2.1M", l: "tokens used" },
    { v: "$31.40", l: "total spend" },
    { v: "3", l: "open gates", accent: true },
  ],
  "Context packs": [
    { v: "412", l: "packs built" },
    { v: "1,908", l: "line-range citations" },
    { v: "−24%", l: "tokens vs raw files", accent: true },
    { v: "100%", l: "cited with reason" },
  ],
  "Review gates": [
    { v: "5", l: "gates configured" },
    { v: "3", l: "open now", accent: true },
    { v: "147", l: "passed" },
    { v: "12", l: "blocked by policy" },
  ],
  Failures: [
    { v: "4", l: "this week" },
    { v: "4", l: "root-caused" },
    { v: "0", l: "open", accent: true },
    { v: "0", l: "recurring" },
  ],
  Costs: [
    { v: "$31.40", l: "this week" },
    { v: "$1,284", l: "this month" },
    { v: "2.1M", l: "tokens" },
    { v: "$0.41", l: "avg / run" },
  ],
  Memory: [
    { v: "5", l: "items stored" },
    { v: "21", l: "recalled / wk", accent: true },
    { v: "4", l: "kinds" },
    { v: "0", l: "repeated mistakes" },
  ],
  Audit: [
    { v: "1,902", l: "events" },
    { v: "6", l: "sensitive", accent: true },
    { v: "100%", l: "source-linked" },
    { v: "0", l: "gaps" },
  ],
  Repos: [
    { v: "4", l: "repositories" },
    { v: "3", l: "healthy" },
    { v: "1", l: "indexing", accent: true },
    { v: "303", l: "sources indexed" },
  ],
};

const statusStyle: Record<string, { dot: string; label: string }> = {
  merged: { dot: "var(--green-11)", label: "merged" },
  reviewing: { dot: ACCENT, label: "review gate" },
  failed: { dot: "var(--red-11)", label: "failed" },
  running: { dot: "var(--blue-11)", label: "running" },
};

const runs = [
  { id: "run-312", task: "workspace setup flow", who: "amara", agent: "claude-sonnet-4", status: "merged", tk: "31,092", cost: "$0.42", pack: "4 files · L88–L233", gate: "tests-pass" },
  { id: "run-316", task: "AFK telemetry flush", who: "deniz", agent: "codex-mini", status: "reviewing", tk: "48,210", cost: "$0.71", pack: "7 files · L12–L401", gate: "context-evidence" },
  { id: "run-331", task: "review-gate enforcement", who: "amara", agent: "claude-sonnet-4", status: "merged", tk: "27,540", cost: "$0.38", pack: "3 files · L140–L291", gate: "no-secret-write" },
  { id: "run-314", task: "workspace members by email", who: "sam", agent: "claude-sonnet-4", status: "failed", tk: "12,800", cost: "$0.18", pack: "2 files · L44–L102", gate: "human-approval" },
  { id: "run-315", task: "agentrail link e2e", who: "deniz", agent: "codex-mini", status: "running", tk: "19,430", cost: "$0.29", pack: "5 files · L66–L188", gate: null },
];

const packs = [
  { f: "lib/response.py", l: "L142–L168", r: "symbol definition", tk: 312 },
  { f: "lib/adapters/http.py", l: "L88–L101", r: "graph expansion", tk: 198 },
  { f: "tests/test_models.py", l: "L12–L40", r: "BM25 keyword match", tk: 421 },
  { f: "lib/models.py", l: "L210–L233", r: "import neighbor", tk: 287 },
  { f: "lib/sessions.py", l: "L303–L341", r: "call-site context", tk: 516 },
  { f: "lib/utils.py", l: "L19–L44", r: "BM25 keyword match", tk: 174 },
];

const gates = [
  { name: "tests-pass", run: "run-312", state: "passed", evidence: "pytest · 142 passed · 0 failed" },
  { name: "context-evidence", run: "run-316", state: "open", evidence: "awaiting pack citation list" },
  { name: "no-secret-write", run: "run-331", state: "passed", evidence: "0 secret paths written" },
  { name: "human-approval", run: "run-314", state: "blocked", evidence: "reviewer: amara" },
  { name: "lint-clean", run: "run-315", state: "passed", evidence: "ruff · 0 violations" },
];

const gateStyle: Record<string, { dot: string; label: string }> = {
  passed: { dot: "var(--green-11)", label: "passed" },
  open: { dot: ACCENT, label: "awaiting evidence" },
  blocked: { dot: "var(--red-11)", label: "blocked" },
};

const failures = [
  { title: "stale embedding hash drops vectors", run: "run-316", cause: "config-hash mismatch", phase: "verify" },
  { title: "migration 0008 silently skipped", run: "run-331", cause: "journal timestamp order", phase: "execute" },
  { title: "members page key warning", run: "run-314", cause: "API contract mismatch", phase: "verify" },
  { title: "context pack missing callers for sessions.py", run: "run-315", cause: "call-site graph incomplete", phase: "plan" },
];

const costRows = [
  { repo: "bensigo/agentrail", pct: 64, v: "$20.10", runs: 84, agent: "claude-sonnet-4" },
  { repo: "psf/requests", pct: 22, v: "$6.90", runs: 31, agent: "codex-mini" },
  { repo: "acme/api", pct: 14, v: "$4.40", runs: 13, agent: "claude-sonnet-4" },
];

const memory = [
  { t: "Drizzle migrations not in _journal.json are silently skipped", k: "reference", recalled: 4 },
  { t: "AFK bases worktrees on origin/main, not local main", k: "project", recalled: 7 },
  { t: "Default to lexical+graph retrieval; embeddings are local-only", k: "decision", recalled: 3 },
  { t: "Workspace package dist/ is gitignored — rebuild on stale import", k: "debug", recalled: 2 },
  { t: "Push tests fail when AGENTRAIL_SERVER_* env vars are set", k: "reference", recalled: 5 },
];

const audit = [
  { ts: "14:02:11", action: "context pack served", who: "claude-sonnet-4 · run-312" },
  { ts: "14:02:48", action: "secret redacted in response", who: "engine · rule: api-key" },
  { ts: "14:03:20", action: "review gate opened", who: "run-316 · context-evidence" },
  { ts: "14:04:07", action: "tool call approved", who: "amara · run-316" },
  { ts: "14:05:02", action: "provider call", who: "anthropic · claude-sonnet-4" },
  { ts: "14:06:31", action: "run completed", who: "run-312 · merged" },
];

const repos = [
  { name: "bensigo/agentrail", branch: "main", health: "healthy", sources: 148, lastRun: "2m ago" },
  { name: "psf/requests", branch: "main", health: "healthy", sources: 94, lastRun: "14m ago" },
  { name: "bensigo/console-ui", branch: "main", health: "healthy", sources: 61, lastRun: "1h ago" },
  { name: "acme/api", branch: "develop", health: "indexing", sources: 0, lastRun: "building" },
];

const repoHealth: Record<string, string> = {
  healthy: "var(--green-11)",
  indexing: ACCENT,
  critical: "var(--red-11)",
};

function Panel({ view }: { view: ViewKey }) {
  if (view === "Runs") {
    return (
      <div className="overflow-hidden rounded-lg border border-[var(--gray-05)]">
        <div className="hidden grid-cols-[108px_1fr_110px_80px_64px] gap-2 border-b border-[var(--gray-04)] bg-[var(--gray-02)] px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-[var(--gray-09)] sm:grid">
          <span>run</span><span>task</span><span>status</span><span>tokens</span><span>cost</span>
        </div>
        {runs.map((r) => {
          const st = statusStyle[r.status];
          return (
            <div
              key={r.id}
              className="grid grid-cols-[108px_1fr_110px] items-center gap-2 border-b border-[var(--gray-04)] px-3 py-2.5 last:border-0 sm:grid-cols-[108px_1fr_110px_80px_64px]"
            >
              <span className="font-mono text-[11px]" style={{ color: ACCENT }}>{r.id}</span>
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
          Pack for <span style={{ color: ACCENT }}>run-312</span> — bounded line ranges, each with a retrieval reason.
        </p>
        <div className="overflow-hidden rounded-lg border border-[var(--gray-05)]">
          <div className="hidden grid-cols-[1fr_80px_1fr_52px] gap-2 border-b border-[var(--gray-04)] bg-[var(--gray-02)] px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-[var(--gray-09)] sm:grid">
            <span>file</span><span>lines</span><span>reason</span><span>tok</span>
          </div>
          {packs.map((p) => (
            <div key={p.f} className="grid grid-cols-[1fr_80px] items-center gap-2 border-b border-[var(--gray-04)] px-3 py-2.5 last:border-0 sm:grid-cols-[1fr_80px_1fr_52px]">
              <span className="font-mono text-[11.5px] text-[var(--gray-12)] truncate">{p.f}</span>
              <span className="font-mono text-[11px]" style={{ color: ACCENT }}>{p.l}</span>
              <span className="hidden font-mono text-[11px] text-[var(--gray-09)] sm:block">{p.r}</span>
              <span className="hidden font-mono text-[11px] text-[var(--gray-09)] sm:block">{p.tk}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (view === "Review gates") {
    return (
      <div className="overflow-hidden rounded-lg border border-[var(--gray-05)]">
        <div className="hidden grid-cols-[1fr_108px_120px_1fr] gap-2 border-b border-[var(--gray-04)] bg-[var(--gray-02)] px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-[var(--gray-09)] sm:grid">
          <span>gate</span><span>run</span><span>status</span><span>evidence</span>
        </div>
        {gates.map((g) => {
          const st = gateStyle[g.state];
          return (
            <div key={g.name} className="grid grid-cols-[1fr_108px_120px] items-center gap-2 border-b border-[var(--gray-04)] px-3 py-2.5 last:border-0 sm:grid-cols-[1fr_108px_120px_1fr]">
              <span className="font-mono text-[12px] text-[var(--gray-12)]">{g.name}</span>
              <span className="font-mono text-[11px]" style={{ color: ACCENT }}>{g.run}</span>
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: st.dot }} />
                <span className="text-[11px]" style={{ color: st.dot }}>{st.label}</span>
              </span>
              <span className="hidden font-mono text-[11px] text-[var(--gray-09)] sm:block truncate">{g.evidence}</span>
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
            <div className="mt-1.5 flex items-center gap-2">
              <span className="inline-block rounded border border-[var(--gray-05)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--gray-09)]">
                root cause: {f.cause}
              </span>
              <span className="inline-block rounded border border-[var(--gray-05)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--gray-08)]">
                phase: {f.phase}
              </span>
            </div>
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
              <span className="min-w-0">
                <span className="font-mono text-[var(--gray-11)]">{c.repo}</span>
                <span className="ml-2 font-mono text-[10px] text-[var(--gray-08)]">{c.agent} · {c.runs} runs</span>
              </span>
              <span className="font-mono text-[var(--gray-12)] tabular-nums">{c.v}</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-[var(--gray-03)]">
              <div className="h-full rounded-full" style={{ width: `${c.pct}%`, background: ACCENT }} />
            </div>
          </div>
        ))}
        <p className="pt-1 font-mono text-[11px] text-[var(--gray-09)]">Token + dollar spend per repo and agent model.</p>
      </div>
    );
  }

  if (view === "Memory") {
    return (
      <div className="space-y-2">
        {memory.map((m) => (
          <div key={m.t} className="flex items-start gap-3 rounded-md border border-[var(--gray-05)] bg-[var(--gray-00)]/60 px-3 py-2.5">
            <span className="flex-1 text-[12px] leading-snug text-[var(--gray-12)]">{m.t}</span>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <span className="rounded-full border border-[var(--gray-05)] px-2 py-0.5 font-mono text-[10px] text-[var(--gray-09)]">{m.k}</span>
              <span className="font-mono text-[10px] text-[var(--gray-08)]">recalled {m.recalled}x</span>
            </div>
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
      <div className="hidden grid-cols-[1fr_72px_64px_110px] gap-2 border-b border-[var(--gray-04)] bg-[var(--gray-02)] px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-[var(--gray-09)] sm:grid">
        <span>repository</span><span>branch</span><span>sources</span><span>health</span>
      </div>
      {repos.map((r) => (
        <div key={r.name} className="grid grid-cols-[1fr_110px] items-center gap-2 border-b border-[var(--gray-04)] px-3 py-2.5 last:border-0 sm:grid-cols-[1fr_72px_64px_110px]">
          <span className="min-w-0">
            <span className="block font-mono text-[12px] text-[var(--gray-12)] truncate">{r.name}</span>
            <span className="font-mono text-[10px] text-[var(--gray-08)]">last run: {r.lastRun}</span>
          </span>
          <span className="hidden font-mono text-[11px] text-[var(--gray-09)] sm:block">{r.branch}</span>
          <span className="hidden font-mono text-[11px] text-[var(--gray-09)] sm:block">{r.sources > 0 ? r.sources : "—"}</span>
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
          interactive · click the sidebar
        </span>
      </div>

      <div className="grid grid-cols-[220px_1fr]">
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

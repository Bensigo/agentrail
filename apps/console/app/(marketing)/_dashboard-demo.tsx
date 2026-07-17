"use client";

import { useState } from "react";
import {
  LayoutDashboard,
  Play,
  ListChecks,
  Plug,
  AlertTriangle,
  ShieldCheck,
  DollarSign,
  TrendingUp,
  Activity,
  Database,
  Brain,
  Key,
  Users,
  type LucideIcon,
} from "lucide-react";

const ACCENT = "var(--yellow-09)";

/* The demo mirrors the real console: the nav, route slugs, table columns,
 * statuses, and metrics below are copied from the live dashboard so the
 * marketing surface never shows something the product doesn't. */

type ViewKey =
  | "Overview"
  | "Runs"
  | "Issue Queue"
  | "Connectors"
  | "Failures"
  | "Review Gates"
  | "Costs"
  | "Scorecard"
  | "Context Quality"
  | "Repos & Health"
  | "Memory"
  | "API Keys"
  | "Team";

const NAV: { label: ViewKey; slug: string; icon: LucideIcon }[] = [
  { label: "Overview", slug: "", icon: LayoutDashboard },
  { label: "Runs", slug: "runs", icon: Play },
  { label: "Issue Queue", slug: "queue", icon: ListChecks },
  { label: "Connectors", slug: "connectors", icon: Plug },
  { label: "Failures", slug: "failures", icon: AlertTriangle },
  { label: "Review Gates", slug: "review-gates", icon: ShieldCheck },
  { label: "Costs", slug: "costs", icon: DollarSign },
  { label: "Scorecard", slug: "scorecard", icon: TrendingUp },
  { label: "Context Quality", slug: "context-quality", icon: Activity },
  { label: "Repos & Health", slug: "repos", icon: Database },
  { label: "Memory", slug: "memory", icon: Brain },
  { label: "API Keys", slug: "api-keys", icon: Key },
  { label: "Team", slug: "members", icon: Users },
];

/* Status / severity / queue-state badge styles — lifted verbatim from the
 * console's status-badge, failures-table, and queue-state-badge. */
const PILL = "inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[11px] font-medium";
const TONE = {
  green: "bg-[var(--green-09)]/20 text-[var(--green-11)] border-[var(--green-09)]/30",
  red: "bg-[var(--red-09)]/20 text-[var(--red-11)] border-[var(--red-09)]/30",
  orange: "bg-[var(--orange-09)]/20 text-[var(--orange-11)] border-[var(--orange-09)]/30",
  yellow: "bg-[var(--yellow-09)]/15 text-[var(--yellow-11)] border-[var(--yellow-09)]/30",
  blue: "bg-[var(--blue-09)]/20 text-[var(--blue-11)] border-[var(--blue-09)]/30",
  purple: "bg-[var(--purple-09)]/20 text-[var(--purple-11)] border-[var(--purple-09)]/30",
  teal: "bg-[var(--teal-11)]/15 text-[var(--teal-11)] border-[var(--teal-11)]/30",
  gray: "bg-[var(--gray-04)] text-[var(--gray-10)] border-[var(--gray-06)]",
} as const;

function Badge({ tone, children }: { tone: keyof typeof TONE; children: React.ReactNode }) {
  return <span className={`${PILL} ${TONE[tone]}`}>{children}</span>;
}

/* ----------------------------------------------------------------- shells */

function TableShell({
  head,
  children,
}: {
  head: string[];
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded border border-[var(--gray-05)]">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)]">
            {head.map((h) => (
              <th
                key={h}
                className="whitespace-nowrap px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-[var(--gray-09)]"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <tr className="border-b border-[var(--gray-04)] last:border-0 hover:bg-[var(--gray-02)]">
      {children}
    </tr>
  );
}

const TD = "px-3 py-2 align-middle whitespace-nowrap";
const MONO = "font-mono text-[11px]";

function FilterBar({ children }: { children: React.ReactNode }) {
  return <div className="mb-3 flex flex-wrap items-center gap-1.5">{children}</div>;
}
function Select({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-7 items-center rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-2 text-[11px] text-[var(--gray-11)]">
      {children}
      <span className="ml-1 text-[var(--gray-08)]">▾</span>
    </span>
  );
}
function RangePills({ active = "24h" }: { active?: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      {["1h", "6h", "24h", "7d", "30d"].map((r) => (
        <span
          key={r}
          className="inline-flex h-7 items-center rounded border px-2 text-[11px] font-medium"
          style={
            r === active
              ? { background: ACCENT, color: "var(--gray-00)", borderColor: ACCENT }
              : { borderColor: "var(--gray-05)", color: "var(--gray-10)" }
          }
        >
          {r}
        </span>
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ panels */

const runs = [
  { feature: "Workspace setup flow", id: "a3f9c2b1", repo: "bensigo/agentrail", branch: "feat/setup-flow", status: "success", agent: "claude", dur: "4m 12s", cost: "$0.0421", saved: "31.0k" },
  { feature: "AFK telemetry timeline", id: "7d2e10aa", repo: "bensigo/agentrail", branch: "feat/afk-telemetry", status: "running", agent: "codex", dur: "2m 38s", cost: "$0.0290", saved: "12.4k" },
  { feature: "Review-gate enforcement", id: "19b4c7f0", repo: "bensigo/agentrail", branch: "fix/gate-enforce", status: "success", agent: "claude", dur: "5m 02s", cost: "$0.0380", saved: "27.5k" },
  { feature: "Members by email", id: "5c1a88de", repo: "acme/api", branch: "feat/members-email", status: "failed", agent: "claude", dur: "1m 47s", cost: "$0.0180", saved: "6.2k" },
  { feature: "Index rebuild", id: "0f3b9a21", repo: "psf/requests", branch: "chore/reindex", status: "queued", agent: "codex", dur: "—", cost: "—", saved: "—" },
];
const runTone: Record<string, keyof typeof TONE> = {
  success: "green", running: "orange", failed: "red", queued: "gray",
};

function RunsPanel() {
  return (
    <>
      <FilterBar>
        <Select>All statuses</Select>
        <Select>All repos</Select>
        <RangePills />
        <span className="inline-flex h-7 items-center rounded border border-[var(--gray-06)] bg-[var(--gray-03)] px-2.5 text-[11px] text-[var(--gray-12)]">
          Apply
        </span>
      </FilterBar>
      <TableShell head={["Feature", "Run ID", "Repo", "Branch", "Status", "Agent", "Duration", "Cost", "Tokens saved"]}>
        {runs.map((r) => (
          <Row key={r.id}>
            <td className={`${TD} text-[12px] font-medium text-[var(--gray-12)]`}>{r.feature}</td>
            <td className={`${TD} ${MONO} text-[var(--gray-12)]`}>{r.id}</td>
            <td className={`${TD} text-[11px] text-[var(--gray-11)]`}>{r.repo}</td>
            <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{r.branch}</td>
            <td className={TD}><Badge tone={runTone[r.status]}>{r.status}</Badge></td>
            <td className={`${TD} text-[11px] text-[var(--gray-11)]`}>{r.agent}</td>
            <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{r.dur}</td>
            <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{r.cost}</td>
            <td className={`${TD} ${MONO} text-[var(--green-11)]`}>{r.saved}</td>
          </Row>
        ))}
      </TableShell>
    </>
  );
}

const queue = [
  { title: "AFK telemetry timeline", key: "#316", agent: "codex", tier: "strong", budget: "1/2", state: "running", tone: "orange", updated: "Jun 18 14:05" },
  { title: "Members by email", key: "#314", agent: "claude", tier: "strong", budget: "0/2", state: "Escalated to human", tone: "red", updated: "Jun 18 13:58" },
  { title: "Webhook dedupe", key: "#320", agent: "claude", tier: "cheap", budget: "2/2", state: "Parked", tone: "blue", updated: "Jun 18 13:51" },
  { title: "Index rebuild", key: "#318", agent: "codex", tier: "cheap", budget: "2/2", state: "Queued", tone: "gray", updated: "Jun 18 13:40" },
] as const;

function QueuePanel() {
  return (
    <>
      <FilterBar>
        {["All", "Queued", "Parked", "Running"].map((f) => (
          <span
            key={f}
            className="inline-flex h-7 items-center rounded border px-2.5 text-[11px] font-medium"
            style={
              f === "Queued"
                ? { background: ACCENT, color: "var(--gray-00)", borderColor: ACCENT }
                : { borderColor: "var(--gray-05)", color: "var(--gray-10)" }
            }
          >
            {f}
          </span>
        ))}
        <span className="ml-auto inline-flex h-7 items-center rounded border border-[var(--gray-05)] px-2.5 text-[11px] text-[var(--gray-10)]">
          Show history
        </span>
      </FilterBar>
      <TableShell head={["Issue", "Agent", "Tier", "Budget", "State", "Updated"]}>
        {queue.map((q) => (
          <Row key={q.key}>
            <td className={TD}>
              <span className="text-[12px] font-medium text-[var(--gray-12)]">{q.title}</span>
              <span className={`ml-2 ${MONO} text-[var(--gray-09)]`}>{q.key}</span>
            </td>
            <td className={`${TD} text-[11px] text-[var(--gray-11)]`}>{q.agent}</td>
            <td className={`${TD} ${MONO} text-[var(--gray-11)]`}>{q.tier}</td>
            <td className={`${TD} ${MONO} ${q.budget.startsWith("0") ? "text-[var(--red-11)]" : "text-[var(--gray-11)]"}`}>{q.budget}</td>
            <td className={TD}><Badge tone={q.tone}>{q.state}</Badge></td>
            <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{q.updated}</td>
          </Row>
        ))}
      </TableShell>
      <p className="mt-2 text-[11px] text-[var(--gray-09)]">
        Tier escalates cheap→strong; each red gate spends one budget unit. At 0 the
        loop hard-stops to a human.
      </p>
    </>
  );
}

const failures = [
  { sev: "high", tone: "orange", type: "build_error", msg: "tsc: Info icon not wrapped for title attribute", repo: "bensigo/agentrail", phase: "verify", run: "7d2e10aa", when: "Jun 18 14:04" },
  { sev: "medium", tone: "yellow", type: "test_error", msg: "migration 0008 silently skipped — journal order", repo: "bensigo/agentrail", phase: "verify", run: "19b4c7f0", when: "Jun 18 13:55" },
  { sev: "critical", tone: "red", type: "context_error", msg: "stale embedding hash drops vectors", repo: "acme/api", phase: "execute", run: "5c1a88de", when: "Jun 18 13:47" },
] as const;

function FailuresPanel() {
  return (
    <>
      <FilterBar>
        <Select>All repos</Select>
        <Select>All severities</Select>
        <Select>All types</Select>
        <RangePills />
      </FilterBar>
      <TableShell head={["Severity", "Type", "Message", "Repo", "Phase", "Run", "When"]}>
        {failures.map((f) => (
          <Row key={f.run + f.type}>
            <td className={TD}><Badge tone={f.tone}>{f.sev}</Badge></td>
            <td className={`${TD} ${MONO} text-[var(--gray-11)]`}>{f.type}</td>
            <td className="px-3 py-2 text-[12px] text-[var(--gray-12)]">{f.msg}</td>
            <td className={`${TD} text-[11px] text-[var(--gray-11)]`}>{f.repo}</td>
            <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{f.phase}</td>
            <td className={`${TD} ${MONO} text-[var(--gray-11)]`}>{f.run}</td>
            <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{f.when}</td>
          </Row>
        ))}
      </TableShell>
    </>
  );
}

const costIssues = [
  { key: "feat/setup-flow", cost: "$0.42" },
  { key: "fix/gate-enforce", cost: "$0.38" },
  { key: "feat/afk-telemetry", cost: "$0.71" },
  { key: "chore/reindex", cost: "$0.12" },
];

function CostsPanel() {
  return (
    <>
      <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-[var(--gray-09)]">
        Cost meter
      </p>
      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <div className="border-l-2 pl-3" style={{ borderColor: ACCENT }}>
          <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--gray-09)]">Cost-per-Issue-to-Green</p>
          <p className="font-mono text-2xl font-semibold leading-none text-[var(--gray-12)]">$0.41</p>
          <p className={`mt-1 ${MONO} text-[var(--gray-09)]`}>avg over 18 green issues</p>
        </div>
        <div className="border-l-2 border-[var(--gray-06)] pl-3">
          <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--gray-09)]">Cache read-to-creation ratio</p>
          <p className="font-mono text-2xl font-semibold leading-none text-[var(--gray-12)]">3.2×</p>
          <p className={`mt-1 ${MONO} text-[var(--gray-09)]`}>1.4M read / 440k created</p>
        </div>
      </div>
      <TableShell head={["Issue (branch)", "Cost to Green"]}>
        {costIssues.map((c) => (
          <Row key={c.key}>
            <td className={`${TD} ${MONO} text-[var(--gray-11)]`}>{c.key}</td>
            <td className={`px-3 py-2 text-right ${MONO} font-medium text-[var(--gray-12)]`}>{c.cost}</td>
          </Row>
        ))}
      </TableShell>
    </>
  );
}

const overviewCards = [
  { label: "Runs", value: "128", icon: Play },
  { label: "Failures", value: "6", icon: AlertTriangle },
  { label: "Review Gates", value: "9", icon: ShieldCheck },
  { label: "Costs", value: "$31.40", detail: "2.1M tokens", icon: DollarSign },
  { label: "Repos & Health", value: "7", icon: Database },
  { label: "Memory", value: "38", icon: Brain },
  { label: "API Keys", value: "3", icon: Key },
  { label: "Team", value: "5", detail: "2 teams", icon: Users },
];

function OverviewPanel() {
  return (
    <>
      <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-[var(--gray-09)]">
        System health
      </p>
      <div className="mb-5 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-4 py-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="border-l-2 border-[#46a758] pl-3">
            <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--gray-09)]">Accept rate</p>
            <p className="font-mono text-2xl font-semibold leading-none text-[var(--gray-12)]">72%</p>
            <p className={`mt-1 ${MONO} text-[var(--gray-09)]`}>18 green / 25 attempted</p>
          </div>
          <div className="border-l-2 border-[var(--gray-06)] pl-3">
            <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--gray-09)]">Escalation rate</p>
            <p className="font-mono text-2xl font-semibold leading-none text-[var(--gray-12)]">12%</p>
            <p className={`mt-1 ${MONO} text-[var(--gray-09)]`}>3 escalated to human / 25 attempted</p>
          </div>
        </div>
        <div className="mt-3">
          <div className="relative h-2.5 w-full overflow-hidden rounded-sm bg-[var(--gray-04)]">
            <div className="h-full bg-[#46a758]" style={{ width: "72%" }} />
            <div className="absolute top-0 h-full w-px bg-[var(--gray-12)]" style={{ left: "50%" }} />
          </div>
          <p className={`mt-1 ${MONO} text-[10px] text-[var(--gray-09)]`}>
            Health line: accept rate &gt; 50% is winning; below is losing
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
        {overviewCards.map(({ label, value, detail, icon: Icon }) => (
          <div key={label} className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-3">
            <div className="flex items-center gap-1.5 text-[var(--gray-09)]">
              <Icon className="h-3.5 w-3.5" />
              <span className="text-[10px] uppercase tracking-wide">{label}</span>
            </div>
            <div className="mt-1.5 flex items-baseline gap-1.5">
              <span className="font-mono text-xl font-bold text-[var(--gray-12)]">{value}</span>
              {detail && <span className={`${MONO} text-[var(--gray-09)]`}>{detail}</span>}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function ConnectorsPanel() {
  const sections: {
    group: string;
    rows: { name: string; cap: string; target?: string; tone: keyof typeof TONE; state: string }[];
  }[] = [
    { group: "HTTPS", rows: [
      { name: "GitHub", cap: "Ingest · Post result", target: "acme/web", tone: "green", state: "connected" },
    ] },
    { group: "MCP", rows: [
      { name: "Linear", cap: "Ingest · Post result · Tools", tone: "gray", state: "not connected" },
      { name: "Context7", cap: "Tools", tone: "green", state: "connected" },
    ] },
    { group: "Gateway", rows: [
      { name: "Slack", cap: "Notify", tone: "green", state: "connected" },
      { name: "Discord", cap: "Notify", tone: "gray", state: "not connected" },
    ] },
  ];
  return (
    <>
      <p className="mb-3 text-[11px] text-[var(--gray-09)]">
        Two-way links between your tools and the Issue Queue — connectors ingest
        issues and post run results back.
      </p>
      <div className="mb-4 flex items-center gap-2 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-3 py-2">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--green-11)]" />
        <span className="text-[12px] font-medium text-[var(--gray-12)]">Heartbeat</span>
        <span className="rounded-full bg-[var(--green-09)]/20 px-2 py-0.5 text-[10px] font-medium text-[var(--green-11)]">2 active</span>
      </div>
      <div className="space-y-4">
        {sections.map((s) => (
          <div key={s.group}>
            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-[var(--gray-09)]">{s.group}</p>
            <div className="space-y-2">
              {s.rows.map((r) => (
                <div key={r.name} className="flex items-center gap-3 rounded border border-[var(--gray-05)] bg-[var(--gray-01)]/60 px-3 py-2.5">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: r.tone === "green" ? "var(--green-11)" : "var(--gray-07)" }} />
                  <span className="text-[12.5px] font-medium text-[var(--gray-12)]">{r.name}</span>
                  <span className="text-[11px] text-[var(--gray-09)]">{r.cap}{r.target ? ` · ${r.target}` : ""}</span>
                  <span className="ml-auto"><Badge tone={r.tone}>{r.state}</Badge></span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function ReviewGatesPanel() {
  const gates = [
    { status: "failed", tone: "red", gate: "Merge gate", run: "a3f8c1d2", findings: "2 findings", evaluated: "3m ago" },
    { status: "passed", tone: "green", gate: "Security review", run: "7b2e9f01", findings: "—", evaluated: "2h ago" },
    { status: "pending", tone: "yellow", gate: "Visual QA", run: "c4d10a55", findings: "1 finding", evaluated: "—" },
  ] as const;
  return (
    <>
      <p className="mb-3 text-[11px] text-[var(--gray-09)]">
        Gates pass or fail on objective evidence only (CI + security). Findings
        are advisory — they never block a merge.
      </p>
      <div className="mb-3 flex gap-5">
        {[{ l: "Passed", v: "14", c: "var(--green-11)" }, { l: "Failed", v: "2", c: "var(--red-11)" }, { l: "Pending", v: "1", c: "var(--yellow-11)" }].map((s) => (
          <div key={s.l}>
            <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--gray-09)]">{s.l}</p>
            <p className="font-mono text-xl font-bold" style={{ color: s.c }}>{s.v}</p>
          </div>
        ))}
      </div>
      <TableShell head={["Status", "Gate", "Findings", "Evaluated"]}>
        {gates.map((g) => (
          <Row key={g.run}>
            <td className={TD}><Badge tone={g.tone}>{g.status}</Badge></td>
            <td className={TD}>
              <span className="text-[12px] text-[var(--gray-12)]">{g.gate}</span>
              <span className={`ml-2 ${MONO} text-[var(--gray-09)]`}>run:{g.run}</span>
            </td>
            <td className={`${TD} text-[11px] text-[var(--gray-10)]`}>{g.findings}</td>
            <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{g.evaluated}</td>
          </Row>
        ))}
      </TableShell>
      <div className="mt-2 flex items-center gap-3 rounded border border-[var(--gray-05)] bg-[var(--gray-01)]/60 px-3 py-2.5">
        <Badge tone="red">critical</Badge>
        <span className="text-[12px] text-[var(--gray-12)]">SQL injection in search handler</span>
        <span className="ml-auto inline-flex shrink-0 items-center rounded border border-[var(--gray-06)] bg-[var(--gray-03)] px-2 py-0.5 text-[11px] text-[var(--gray-11)]">
          Create issue
        </span>
      </div>
    </>
  );
}

function ScorecardPanel() {
  return (
    <div className="space-y-5">
      <div>
        <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-[var(--gray-09)]">By agent</p>
        <TableShell head={["Agent", "Runs", "Finished", "Success rate", "Avg duration", "Avg review rounds"]}>
          {[
            { a: "executor", r: "142", f: "138", s: "97.1%", d: "4m 12s", rr: "1.2" },
            { a: "planner", r: "96", f: "94", s: "92.7%", d: "2m 03s", rr: "1.0" },
          ].map((x) => (
            <Row key={x.a}>
              <td className={`${TD} ${MONO} text-[var(--gray-12)]`}>{x.a}</td>
              <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{x.r}</td>
              <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{x.f}</td>
              <td className={`${TD} ${MONO}`} style={{ color: "#30a46c" }}>{x.s}</td>
              <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{x.d}</td>
              <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{x.rr}</td>
            </Row>
          ))}
        </TableShell>
      </div>
      <div>
        <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-[var(--gray-09)]">By model</p>
        <TableShell head={["Model", "Runs", "Total cost", "Avg cost/run", "Input tokens", "Output tokens", "Cache tokens", "Cache ratio"]}>
          {[
            { m: "claude-opus-4-8", r: "210", t: "$48.7321", a: "$0.2321", i: "4.2M", o: "310.5k", c: "1.8M", cr: "42.0%" },
            { m: "claude-sonnet-4-6", r: "318", t: "$11.0420", a: "$0.0347", i: "6.1M", o: "402.0k", c: "3.7M", cr: "61.0%" },
          ].map((x) => (
            <Row key={x.m}>
              <td className={`${TD} ${MONO} text-[var(--gray-12)]`}>{x.m}</td>
              <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{x.r}</td>
              <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{x.t}</td>
              <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{x.a}</td>
              <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{x.i}</td>
              <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{x.o}</td>
              <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{x.c}</td>
              <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{x.cr}</td>
            </Row>
          ))}
        </TableShell>
      </div>
      <div>
        <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-[var(--gray-09)]">By runner</p>
        <TableShell head={["Runner", "Runs", "Success rate", "Review fix rate", "Human review rate", "Cost/merged PR", "Context efficiency"]}>
          {[
            { n: "self-hosted-runner-01", r: "64", s: "95.0%", rf: "12.0%", h: "8.0%", c: "$0.4210", ce: "83.0%" },
          ].map((x) => (
            <Row key={x.n}>
              <td className={`${TD} text-[12px] text-[var(--blue-11)]`}>{x.n}</td>
              <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{x.r}</td>
              <td className={`${TD} ${MONO}`} style={{ color: "#30a46c" }}>{x.s}</td>
              <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{x.rf}</td>
              <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{x.h}</td>
              <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{x.c}</td>
              <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{x.ce}</td>
            </Row>
          ))}
        </TableShell>
      </div>
    </div>
  );
}

function ContextQualityPanel() {
  const kpis = [
    { l: "Precision at budget", v: "72%", d: "↑ +3pp vs 30d baseline", up: true },
    { l: "Citation coverage", v: "85%", d: "↑ +1pp vs 30d baseline", up: true },
    { l: "Stale sources", v: "3", d: "↓ −2 vs 30d baseline", up: true },
    { l: "Denied sources", v: "1", d: "No baseline yet (3/5 runs)", up: null as boolean | null },
  ];
  const rot = [
    { type: "Memory Item", tone: "green", name: "auth-service architecture notes", stale: "42d ago", pts: "18.3 pts" },
    { type: "Index Snapshot", tone: "yellow", name: "payments-api index", stale: "9d ago", pts: "7.5 pts" },
    { type: "Source Hash Churn", tone: "teal", name: "src/billing/*.ts churn", stale: "—", pts: "4.2 pts" },
  ] as const;
  return (
    <>
      <div className="mb-3 flex items-center gap-2 rounded border border-[var(--green-09)]/30 bg-[var(--green-09)]/10 px-3 py-2">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--green-11)]" />
        <span className="text-[12px] text-[var(--green-11)]">All metrics stable</span>
        <span className="ml-auto font-mono text-[11px] text-[var(--gray-09)]">12 runs · 30d · latest 06-13</span>
      </div>
      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        {kpis.map((k) => (
          <div key={k.l} className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-3">
            <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--gray-09)]">{k.l}</p>
            <p className="mt-1 font-mono text-xl font-bold text-[var(--gray-12)]">{k.v}</p>
            <p className="mt-0.5 font-mono text-[10px]" style={{ color: k.up === null ? "var(--gray-09)" : "var(--green-11)" }}>{k.d}</p>
          </div>
        ))}
      </div>
      <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-[var(--gray-09)]">Context rot score</p>
      <div className="mb-3 flex items-center gap-3 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-4 py-3">
        <span className="font-mono text-3xl font-bold" style={{ color: "var(--yellow-11)" }}>34</span>
        <span className="text-[11px] text-[var(--gray-09)]">Risk score · 0–100, lower is better</span>
      </div>
      <TableShell head={["Type", "Name", "Staleness", "Contribution"]}>
        {rot.map((r) => (
          <Row key={r.name}>
            <td className={TD}><Badge tone={r.tone}>{r.type}</Badge></td>
            <td className={`${TD} text-[12px] text-[var(--blue-11)]`}>{r.name}</td>
            <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{r.stale}</td>
            <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{r.pts}</td>
          </Row>
        ))}
      </TableShell>
    </>
  );
}

function ReposPanel() {
  const rows = [
    { name: "bensigo/agentrail", branch: "main", health: "healthy", tone: "green", sha: "88ea5dc1", age: "4m ago", units: "12,480" },
    { name: "bensigo/ai-workflow", branch: "feat/health-on-overview", health: "stale", tone: "yellow", sha: "91c95f6a", age: "3h ago", units: "8,204" },
    { name: "bensigo/db-clickhouse", branch: "main", health: "critical", tone: "red", sha: "—", age: "6d ago", units: "—" },
  ] as const;
  const dot: Record<string, string> = { healthy: "var(--green-09)", stale: "var(--yellow-09)", critical: "var(--red-09)" };
  const txt: Record<string, string> = { healthy: "var(--green-11)", stale: "var(--yellow-11)", critical: "var(--red-11)" };
  return (
    <TableShell head={["Health", "Repository", "Last Commit", "Index Age", "Codebase Units", ""]}>
      {rows.map((r) => (
        <Row key={r.name}>
          <td className={TD}>
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: dot[r.health] }} />
              <span className="text-[11px]" style={{ color: txt[r.health] }}>{r.health}</span>
            </span>
          </td>
          <td className={TD}>
            <span className="block text-[12px] text-[var(--gray-12)]">{r.name}</span>
            <span className={`block ${MONO} text-[var(--gray-09)]`}>{r.branch}</span>
          </td>
          <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{r.sha}</td>
          <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{r.age}</td>
          <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{r.units}</td>
          <td className={`${TD} text-right text-[11px] text-[var(--blue-11)]`}>Re-index</td>
        </Row>
      ))}
    </TableShell>
  );
}

function MemoryPanel() {
  const rows = [
    { src: "CLAUDE.md", repo: "bensigo/agentrail", preview: "AFK worktree base is origin/main, not local main — push fixes first", created: "Jun 16, 09:14", used: "Jun 18, 11:02" },
    { src: ".agentrail/config.json", repo: "—", preview: "Per-phase model split: Fable plans / Opus executes / sonnet reviews", created: "Jun 12, 18:40", used: "—" },
    { src: "docs/CONTEXT.md", repo: "bensigo/db-clickhouse", preview: "Drizzle migrations need a journal entry or they're silently skipped", created: "Jun 10, 14:05", used: "Jun 17, 08:20" },
  ];
  return (
    <>
      <p className="mb-3 text-right text-[11px] text-[var(--gray-09)]">Memory is managed via the AgentRail CLI.</p>
      <TableShell head={["Source", "Repository", "Content preview", "Created", "Last used"]}>
        {rows.map((m) => (
          <Row key={m.src}>
            <td className={`${TD} ${MONO} text-[var(--gray-12)]`}>{m.src}</td>
            <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{m.repo}</td>
            <td className="px-3 py-2 text-[12px] text-[var(--gray-11)]">{m.preview}</td>
            <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{m.created}</td>
            <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{m.used}</td>
          </Row>
        ))}
      </TableShell>
    </>
  );
}

function ApiKeysPanel() {
  const rows = [
    { status: "active", tone: "green", name: "CI deployment key", key: "agr_live_8fa2…****", created: "Jun 18, 2026, 14:32", used: "Jun 18, 2026, 15:07" },
    { status: "active", tone: "green", name: "Production runner", key: "agr_live_3b91…****", created: "Jun 12, 2026, 09:11", used: "Jun 17, 2026, 22:40" },
    { status: "revoked", tone: "gray", name: "Local dev (deprecated)", key: "agr_live_c7de…****", created: "May 30, 2026, 17:02", used: "—" },
  ] as const;
  return (
    <>
      <p className="mb-3 text-[11px] text-[var(--gray-09)]">Authenticate CLI and integrations against this workspace.</p>
      <TableShell head={["Status", "Name", "Key", "Created", "Last used", "Actions"]}>
        {rows.map((r) => (
          <Row key={r.name}>
            <td className={TD}><Badge tone={r.tone}>{r.status}</Badge></td>
            <td className={`${TD} text-[12px] text-[var(--gray-12)]`}>{r.name}</td>
            <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{r.key}</td>
            <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{r.created}</td>
            <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{r.used}</td>
            <td className={`${TD} text-[11px] text-[var(--red-11)]`}>{r.status === "active" ? "Revoke" : ""}</td>
          </Row>
        ))}
      </TableShell>
    </>
  );
}

function TeamPanel() {
  const members = [
    { email: "ada@bensigo.ai", you: true, name: "Ada Lovelace", role: "owner", tone: "purple", joined: "Jun 02, 2026" },
    { email: "grace@bensigo.ai", you: false, name: "Grace Hopper", role: "admin", tone: "blue", joined: "Jun 09, 2026" },
    { email: "linus@bensigo.ai", you: false, name: "Linus Torvalds", role: "member", tone: "gray", joined: "Jun 15, 2026" },
  ] as const;
  return (
    <div className="space-y-5">
      <div>
        <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-[var(--gray-09)]">Members</p>
        <TableShell head={["Email", "Name", "Role", "Joined"]}>
          {members.map((m) => (
            <Row key={m.email}>
              <td className={`${TD} ${MONO} text-[var(--gray-12)]`}>
                {m.email}{m.you ? <span className="text-[var(--gray-09)]"> (you)</span> : null}
              </td>
              <td className={`${TD} text-[12px] text-[var(--gray-11)]`}>{m.name}</td>
              <td className={TD}><Badge tone={m.tone}>{m.role}</Badge></td>
              <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{m.joined}</td>
            </Row>
          ))}
        </TableShell>
      </div>
      <div>
        <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-[var(--gray-09)]">Pending invites</p>
        <TableShell head={["Email", "Role", "Sent", "Accept link", "Actions"]}>
          <Row>
            <td className={`${TD} ${MONO} text-[var(--gray-12)]`}>margaret@bensigo.ai</td>
            <td className={TD}><Badge tone="gray">member</Badge></td>
            <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>Jun 17, 2026</td>
            <td className={`${TD} text-[11px] text-[var(--blue-11)]`}>Copy link</td>
            <td className={`${TD} text-[11px] text-[var(--red-11)]`}>Revoke</td>
          </Row>
        </TableShell>
      </div>
      <div>
        <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-[var(--gray-09)]">Teams</p>
        <TableShell head={["Team", "Members", "Repositories"]}>
          {[
            { t: "Platform", m: "4", r: "console · agentrail · db-clickhouse" },
            { t: "Growth", m: "2", r: "marketing-site" },
          ].map((x) => (
            <Row key={x.t}>
              <td className={`${TD} text-[12px] text-[var(--gray-12)]`}>{x.t}</td>
              <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{x.m}</td>
              <td className={`${TD} ${MONO} text-[var(--gray-10)]`}>{x.r}</td>
            </Row>
          ))}
        </TableShell>
      </div>
    </div>
  );
}

function Panel({ view }: { view: ViewKey }) {
  switch (view) {
    case "Overview": return <OverviewPanel />;
    case "Runs": return <RunsPanel />;
    case "Issue Queue": return <QueuePanel />;
    case "Connectors": return <ConnectorsPanel />;
    case "Failures": return <FailuresPanel />;
    case "Review Gates": return <ReviewGatesPanel />;
    case "Costs": return <CostsPanel />;
    case "Scorecard": return <ScorecardPanel />;
    case "Context Quality": return <ContextQualityPanel />;
    case "Repos & Health": return <ReposPanel />;
    case "Memory": return <MemoryPanel />;
    case "API Keys": return <ApiKeysPanel />;
    case "Team": return <TeamPanel />;
  }
}

/* ------------------------------------------------------------------- demo */

export function DashboardDemo() {
  const [view, setView] = useState<ViewKey>("Overview");
  const slug = NAV.find((n) => n.label === view)?.slug ?? "";

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--gray-05)] bg-[var(--gray-00)] shadow-[0_40px_120px_-40px_rgba(0,0,0,0.8)]">
      {/* window chrome */}
      <div className="flex items-center gap-2 border-b border-[var(--gray-04)] bg-[var(--gray-02)] px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-[var(--gray-06)]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[var(--gray-06)]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[var(--gray-06)]" />
        <span className="ml-3 rounded bg-[var(--gray-00)] px-3 py-1 font-mono text-[11px] text-[var(--gray-09)]">
          app.agentrail.dev/dashboard/acme{slug ? `/${slug}` : ""}
        </span>
        <span className="ml-auto hidden font-mono text-[10px] uppercase tracking-wider text-[var(--gray-08)] sm:inline">
          live demo · click the sidebar ↓
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[200px_1fr]">
        {/* sidebar — mirrors the real console nav */}
        <aside className="hidden flex-col border-r border-[var(--gray-05)] bg-[var(--gray-01)] sm:flex">
          <div className="flex h-11 items-center border-b border-[var(--gray-05)] px-3">
            <span className="text-[13px] font-bold text-[var(--gray-12)]">AgentRail</span>
          </div>
          <div className="border-b border-[var(--gray-04)] p-2">
            <div className="flex items-center justify-between rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-2 py-1.5">
              <span className="flex items-center gap-2">
                <span className="flex h-4 w-4 items-center justify-center rounded text-[10px] font-bold text-black" style={{ background: ACCENT }}>A</span>
                <span className="text-[12px] font-medium text-[var(--gray-12)]">Acme</span>
              </span>
              <span className="text-[var(--gray-08)]">▾</span>
            </div>
          </div>
          <nav className="flex-1 overflow-y-auto p-2">
            {NAV.map(({ label, icon: Icon }) => {
              const active = label === view;
              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => setView(label)}
                  className="relative flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-[var(--gray-02)]"
                  style={{
                    background: active ? "var(--gray-03)" : "transparent",
                    color: active ? ACCENT : "var(--gray-11)",
                  }}
                >
                  {active && (
                    <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r-sm" style={{ background: ACCENT }} />
                  )}
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span>{label}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        {/* main */}
        <div className="min-w-0">
          {/* top bar — breadcrumb + theme toggle, like the real layout */}
          <div className="flex h-11 items-center justify-between border-b border-[var(--gray-05)] px-4">
            <span className="font-mono text-[11px] text-[var(--gray-09)]">
              Acme <span className="text-[var(--gray-07)]">/</span>{" "}
              <span className="text-[var(--gray-11)]">{view}</span>
            </span>
            <span className="h-3.5 w-3.5 rounded-full border border-[var(--gray-06)]" />
          </div>

          {/* mobile nav (sidebar is desktop-only) */}
          <div className="flex gap-1.5 overflow-x-auto border-b border-[var(--gray-04)] p-2 sm:hidden">
            {NAV.map(({ label }) => (
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

          <div className="p-4 sm:p-5">
            <Panel view={view} />
          </div>
        </div>
      </div>
    </div>
  );
}

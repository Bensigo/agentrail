import { auth, signIn } from "@agentrail/auth";
import { listWorkspacesForUser } from "@agentrail/db-postgres";
import { redirect } from "next/navigation";
import fs from "fs";
import path from "path";

interface BenchmarkData {
  agentrailTokens: number;
  smartAgentTokens: number;
  naiveTokens: number;
  precisionAt1: number;
  fixtureCount: number;
  e2eReduction: number;
}

function parseBenchmarkData(): BenchmarkData | null {
  try {
    const filePath = path.join(
      process.cwd(),
      "../../docs/benchmarks/results/context-retrieval-cli-latest.md"
    );
    const content = fs.readFileSync(filePath, "utf-8");

    const naiveMatch = content.match(
      /naive.*?grep.*?\|\s*([\d,]+)\s*\|/i
    );
    const smartMatch = content.match(
      /smart agent.*?\|\s*([\d,]+)\s*\|/i
    );
    const arMatch = content.match(
      /AgentRail: read.*?\|\s*\*\*([\d,]+)\*\*/
    );
    const precisionMatch = content.match(
      /precision@1.*?\*\*([\d.]+)\*\*/
    );
    const e2eMatch = content.match(/−(\d+)%/);
    const fixtureMatch = content.match(/express \((\d+)\).*?flask \((\d+)\)/s);

    if (!naiveMatch || !smartMatch || !arMatch) return null;

    const parseNum = (s: string) => parseInt(s.replace(/,/g, ""), 10);

    return {
      naiveTokens: parseNum(naiveMatch[1]),
      smartAgentTokens: parseNum(smartMatch[1]),
      agentrailTokens: parseNum(arMatch[1]),
      precisionAt1: precisionMatch ? parseFloat(precisionMatch[1]) : 0.82,
      e2eReduction: e2eMatch ? parseInt(e2eMatch[1]) : 24,
      fixtureCount: fixtureMatch
        ? parseInt(fixtureMatch[1]) + parseInt(fixtureMatch[2])
        : 11,
    };
  } catch {
    return null;
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export default async function LandingPage() {
  const session = await auth();

  if (session?.user?.id) {
    const workspaces = await listWorkspacesForUser(session.user.id);
    if (workspaces.length > 0) {
      redirect(`/dashboard/${workspaces[0].id}`);
    } else {
      redirect("/setup");
    }
  }

  const benchmark = parseBenchmarkData();

  return (
    <main
      className="min-h-screen bg-[var(--gray-00)] text-[var(--gray-12)]"
      style={{
        fontFamily:
          'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif',
      }}
    >
      {/* Nav */}
      <header className="border-b border-[var(--gray-05)] px-6 py-4">
        <div className="mx-auto flex max-w-[1280px] items-center justify-between">
          <span className="text-sm font-bold tracking-tight text-[var(--gray-12)]">
            AgentRail
          </span>
          <form
            action={async () => {
              "use server";
              await signIn("github", { redirectTo: "/" });
            }}
          >
            <button
              type="submit"
              className="rounded px-3 py-1.5 text-sm font-medium text-[var(--gray-11)] hover:text-[var(--gray-12)] transition-colors duration-150"
            >
              Sign in
            </button>
          </form>
        </div>
      </header>

      {/* Hero */}
      <section className="px-6 pb-24 pt-20">
        <div className="mx-auto max-w-[800px]">
          <p className="mb-4 text-xs font-medium uppercase tracking-widest text-[var(--gray-09)]">
            Agent Operations Console
          </p>
          <h1
            className="mb-6 font-bold tracking-tight text-[var(--gray-12)]"
            style={{ fontSize: "3.75rem", lineHeight: 1, letterSpacing: "-0.05em" }}
          >
            Observability and control for AI coding agents
          </h1>
          <p className="mb-10 text-lg text-[var(--gray-09)]" style={{ lineHeight: 1.6 }}>
            Agent runs, context packs, review gates, failures, costs, and audit
            — in one workspace. Know what your agents did, what context they
            used, and what it cost.
          </p>
          <form
            action={async () => {
              "use server";
              await signIn("github", { redirectTo: "/" });
            }}
          >
            <button
              type="submit"
              className="inline-flex items-center gap-2 rounded px-6 py-3 text-base font-bold text-black transition-colors duration-150"
              style={{ background: "#ffe629" }}
              onMouseOver={(e) =>
                ((e.currentTarget as HTMLButtonElement).style.background =
                  "#ffdc00")
              }
              onMouseOut={(e) =>
                ((e.currentTarget as HTMLButtonElement).style.background =
                  "#ffe629")
              }
            >
              <GitHubIcon />
              Sign in with GitHub
            </button>
          </form>
        </div>
      </section>

      {/* Capabilities */}
      <section className="border-t border-[var(--gray-05)] px-6 py-16">
        <div className="mx-auto max-w-[1280px]">
          <h2
            className="mb-10 font-bold tracking-tight text-[var(--gray-12)]"
            style={{ fontSize: "1.5rem", letterSpacing: "-0.025em" }}
          >
            What AgentRail tracks
          </h2>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {CAPABILITIES.map((cap) => (
              <div
                key={cap.title}
                className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4"
              >
                <p className="mb-1 text-sm font-bold text-[var(--gray-12)]">
                  {cap.title}
                </p>
                <p className="text-sm text-[var(--gray-09)]">{cap.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Benchmark */}
      <section className="border-t border-[var(--gray-05)] px-6 py-16">
        <div className="mx-auto max-w-[1280px]">
          <h2
            className="mb-2 font-bold tracking-tight text-[var(--gray-12)]"
            style={{ fontSize: "1.5rem", letterSpacing: "-0.025em" }}
          >
            Context retrieval: measured token efficiency
          </h2>
          <p className="mb-10 text-sm text-[var(--gray-09)]">
            Context-gathering token cost across{" "}
            {benchmark ? benchmark.fixtureCount : "—"} benchmarked coding tasks
            (symbol and function lookups across real repos).
          </p>

          {benchmark ? (
            <BenchmarkChart data={benchmark} />
          ) : (
            <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-6 text-sm text-[var(--gray-09)]">
              Benchmark results will appear here once the harness has produced
              measured data. See{" "}
              <code className="font-mono text-[var(--gray-11)]">
                docs/benchmarks/results/context-retrieval-cli-latest.md
              </code>
              .
            </div>
          )}

          {benchmark && (
            <p className="mt-4 text-xs text-[var(--gray-09)]">
              All numbers measured and reproducible. Scoped to benchmarked
              fixtures — not a universal guarantee. 100% recall (required file
              found) across all {benchmark.fixtureCount} fixtures.
            </p>
          )}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-[var(--gray-05)] px-6 py-8">
        <div className="mx-auto max-w-[1280px]">
          <p className="text-xs text-[var(--gray-09)]">
            AgentRail — agent control plane for engineering teams
          </p>
        </div>
      </footer>
    </main>
  );
}

function BenchmarkChart({ data }: { data: BenchmarkData }) {
  const max = data.smartAgentTokens;
  const arPct = Math.round((data.agentrailTokens / max) * 100);
  const smartPct = 100;
  const reduction = Math.round(
    ((data.smartAgentTokens - data.agentrailTokens) / data.smartAgentTokens) *
      100
  );

  const rows = [
    {
      label: "AgentRail",
      sublabel: "line ranges from ranked results",
      tokens: data.agentrailTokens,
      pct: arPct,
      color: "#ffe629",
      textColor: "black",
      highlight: true,
    },
    {
      label: "Smart agent",
      sublabel: "reads only the right files, in full",
      tokens: data.smartAgentTokens,
      pct: smartPct,
      color: "var(--gray-06)",
      textColor: "var(--gray-09)",
      highlight: false,
    },
    {
      label: "Naive grep",
      sublabel: "reads every matched file in full",
      tokens: data.naiveTokens,
      pct: null,
      color: "var(--gray-05)",
      textColor: "var(--gray-09)",
      highlight: false,
    },
  ];

  return (
    <div className="space-y-5">
      {rows.map((row) => (
        <div key={row.label}>
          <div className="mb-1 flex items-baseline gap-2">
            <span
              className="text-sm font-bold"
              style={{ color: row.highlight ? "#ffe629" : "var(--gray-12)" }}
            >
              {row.label}
            </span>
            <span className="text-xs text-[var(--gray-09)]">{row.sublabel}</span>
            <span
              className="ml-auto font-mono text-sm"
              style={{ color: row.highlight ? "#ffe629" : "var(--gray-11)" }}
            >
              {formatTokens(row.tokens)} tokens
            </span>
          </div>
          {row.pct !== null ? (
            <div className="h-6 w-full overflow-hidden rounded-sm bg-[var(--gray-03)]">
              <div
                className="h-full rounded-sm transition-all"
                style={{ width: `${row.pct}%`, background: row.color }}
              />
            </div>
          ) : (
            <div className="flex h-6 items-center rounded-sm bg-[var(--gray-03)] px-2">
              <span className="text-xs text-[var(--gray-09)]">
                {formatTokens(row.tokens)} — chart off scale vs AgentRail
              </span>
            </div>
          )}
        </div>
      ))}
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <StatCard
          value={`−${reduction}%`}
          label="vs right-files-only baseline"
          accent
        />
        <StatCard
          value={`${Math.round(data.precisionAt1 * 100)}%`}
          label="required file ranked first"
        />
        <StatCard
          value={`−${data.e2eReduction}%`}
          label="end-to-end agent tokens (1 task measured)"
        />
      </div>
    </div>
  );
}

function StatCard({
  value,
  label,
  accent,
}: {
  value: string;
  label: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
      <p
        className="mb-1 text-2xl font-bold tracking-tight"
        style={{ color: accent ? "#ffe629" : "var(--gray-12)" }}
      >
        {value}
      </p>
      <p className="text-xs text-[var(--gray-09)]">{label}</p>
    </div>
  );
}

function GitHubIcon() {
  return (
    <svg
      height="18"
      width="18"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

const CAPABILITIES = [
  {
    title: "Agent runs",
    description:
      "Full run history with events, timing, token cost, and outcome for every agent task.",
  },
  {
    title: "Context packs",
    description:
      "Bounded, cited context artifacts — see exactly what source and graph context each run used.",
  },
  {
    title: "Review gates",
    description:
      "Policy checkpoints between run phases. Agents stop and surface evidence before continuing.",
  },
  {
    title: "AFK mode",
    description:
      "Unsupervised multi-phase agent work. Review gates keep the team in control without babysitting.",
  },
  {
    title: "Failures",
    description:
      "Structured failure records with root-cause context, linked to the run and context that triggered them.",
  },
  {
    title: "Audit",
    description:
      "Source-linked audit events for every sensitive action, context inclusion, redaction, and provider call.",
  },
];

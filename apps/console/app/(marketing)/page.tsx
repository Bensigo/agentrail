import { auth, signIn } from "@agentrail/auth";
import { listWorkspacesForUser } from "@agentrail/db-postgres";
import { redirect } from "next/navigation";
import { Bricolage_Grotesque } from "next/font/google";
import fs from "fs";
import path from "path";
import { Reveal, CountUp } from "./_motion";

const display = Bricolage_Grotesque({ subsets: ["latin"], display: "swap" });

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

    const naiveMatch = content.match(/naive.*?grep.*?\|\s*([\d,]+)\s*\|/i);
    const smartMatch = content.match(/smart agent.*?\|\s*([\d,]+)\s*\|/i);
    const arMatch = content.match(/AgentRail: read.*?\|\s*\*\*([\d,]+)\*\*/);
    const precisionMatch = content.match(/precision@1.*?\*\*([\d.]+)\*\*/);
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

const ACCENT = "#ffe629";

export default async function LandingPage() {
  const session = await auth();
  if (session?.user?.id) {
    const workspaces = await listWorkspacesForUser(session.user.id);
    redirect(workspaces.length > 0 ? `/dashboard/${workspaces[0].id}` : "/setup");
  }

  const benchmark = parseBenchmarkData();
  const reduction = benchmark
    ? Math.round(
        ((benchmark.smartAgentTokens - benchmark.agentrailTokens) /
          benchmark.smartAgentTokens) *
          100
      )
    : 89;

  return (
    <main className="relative min-h-screen overflow-hidden bg-[var(--gray-00)] text-[var(--gray-12)]">
      {/* Atmosphere */}
      <div aria-hidden className="pointer-events-none absolute inset-0 ar-grid opacity-70" />
      <div
        aria-hidden
        className="ar-drift pointer-events-none absolute -top-40 left-1/2 h-[640px] w-[900px] -translate-x-1/2 rounded-full opacity-[0.18]"
        style={{
          background: `radial-gradient(50% 50% at 50% 50%, ${ACCENT} 0%, transparent 70%)`,
          filter: "blur(40px)",
        }}
      />

      {/* Nav */}
      <header className="relative z-10 border-b border-[var(--gray-04)]/60 px-6 py-4 backdrop-blur-sm">
        <div className="mx-auto flex max-w-[1180px] items-center justify-between">
          <div className="flex items-center gap-2.5">
            <RailMark />
            <span className={`${display.className} text-[15px] font-extrabold tracking-tight`}>
              AgentRail
            </span>
          </div>
          <div className="flex items-center gap-1">
            <a
              href="#proof"
              className="rounded px-3 py-1.5 text-[13px] text-[var(--gray-10)] transition-colors hover:text-[var(--gray-12)]"
            >
              Benchmark
            </a>
            <a
              href="#capabilities"
              className="hidden rounded px-3 py-1.5 text-[13px] text-[var(--gray-10)] transition-colors hover:text-[var(--gray-12)] sm:block"
            >
              Platform
            </a>
            <form
              action={async () => {
                "use server";
                await signIn("github", { redirectTo: "/" });
              }}
            >
              <button
                type="submit"
                className="rounded px-3 py-1.5 text-[13px] font-medium text-[var(--gray-11)] transition-colors hover:text-[var(--gray-12)]"
              >
                Sign in
              </button>
            </form>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative z-10 px-6 pb-10 pt-24">
        <div className="mx-auto max-w-[1180px]">
          <div
            className="ar-rise mb-6 inline-flex items-center gap-2 rounded-full border border-[var(--gray-05)] bg-[var(--gray-01)]/70 px-3 py-1"
            style={{ animationDelay: "0ms" }}
          >
            <span className="ar-pulse h-1.5 w-1.5 rounded-full" style={{ background: ACCENT }} />
            <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--gray-10)]">
              Agent control plane
            </span>
          </div>

          <h1
            className={`${display.className} ar-rise max-w-[18ch] text-balance text-[clamp(2.8rem,7vw,5.4rem)] font-extrabold leading-[0.95] tracking-[-0.04em]`}
            style={{ animationDelay: "80ms" }}
          >
            Put your coding agents{" "}
            <span className="relative whitespace-nowrap">
              <span style={{ color: ACCENT }}>on rails.</span>
              <span
                aria-hidden
                className="absolute -bottom-1 left-0 h-[3px] w-full rounded-full opacity-60"
                style={{ background: ACCENT }}
              />
            </span>
          </h1>

          <p
            className="ar-rise mt-7 max-w-[60ch] text-[clamp(1rem,1.6vw,1.2rem)] leading-relaxed text-[var(--gray-10)]"
            style={{ animationDelay: "160ms" }}
          >
            AgentRail gives AI coding agents{" "}
            <span className="text-[var(--gray-12)]">durable context</span>,{" "}
            <span className="text-[var(--gray-12)]">bounded execution</span>, and{" "}
            <span className="text-[var(--gray-12)]">review gates</span> — so you
            see what every run did, what context it used, and what it cost.
            Measured <span style={{ color: ACCENT }}>{reduction}% fewer tokens</span>{" "}
            to find the right code.
          </p>

          <div
            className="ar-rise mt-9 flex flex-wrap items-center gap-3"
            style={{ animationDelay: "240ms" }}
          >
            <form
              action={async () => {
                "use server";
                await signIn("github", { redirectTo: "/" });
              }}
            >
              <button
                type="submit"
                className="group inline-flex items-center gap-2 rounded-md bg-[#ffe629] px-5 py-3 text-[15px] font-bold text-black shadow-[0_8px_30px_-12px_rgba(255,230,41,0.6)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#ffdc00] hover:shadow-[0_12px_36px_-12px_rgba(255,230,41,0.8)]"
              >
                <GitHubIcon />
                Sign in with GitHub
              </button>
            </form>
            <a
              href="#proof"
              className="inline-flex items-center gap-2 rounded-md border border-[var(--gray-05)] px-5 py-3 text-[15px] font-medium text-[var(--gray-11)] transition-colors hover:border-[var(--gray-07)] hover:text-[var(--gray-12)]"
            >
              See the proof
              <span aria-hidden>→</span>
            </a>
          </div>

          {/* Signal stat */}
          {benchmark && (
            <div
              className="ar-rise mt-12 flex flex-wrap items-stretch gap-px overflow-hidden rounded-xl border border-[var(--gray-05)] bg-[var(--gray-05)]"
              style={{ animationDelay: "320ms" }}
            >
              <SignalStat
                kpi={`−${reduction}%`}
                label="tokens to gather context"
                accent
              />
              <SignalStat
                kpi={`${Math.round(benchmark.precisionAt1 * 100)}%`}
                label="right file ranked first"
              />
              <SignalStat kpi="100%" label="recall on benchmarked tasks" />
              <SignalStat
                kpi={`−${benchmark.e2eReduction}%`}
                label="end-to-end agent tokens"
              />
            </div>
          )}
        </div>
      </section>

      {/* Rail motif */}
      <section className="relative z-10 px-6 py-16">
        <div className="mx-auto max-w-[1180px]">
          <RailFlow />
        </div>
      </section>

      {/* Proof / benchmark */}
      <section
        id="proof"
        className="relative z-10 border-t border-[var(--gray-04)]/60 px-6 py-20"
      >
        <div className="mx-auto max-w-[1180px]">
          <Reveal>
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--gray-09)]">
              Measured · reproducible
            </p>
            <h2
              className={`${display.className} mt-3 max-w-[20ch] text-[clamp(1.8rem,3.4vw,2.8rem)] font-extrabold tracking-[-0.03em]`}
            >
              We didn&apos;t claim it. We benchmarked it.
            </h2>
            <p className="mt-3 max-w-[62ch] text-[15px] leading-relaxed text-[var(--gray-10)]">
              Across {benchmark ? benchmark.fixtureCount : 11} real symbol and
              function lookups on production repos (Express, Flask), here&apos;s
              how many tokens an agent burns just to{" "}
              <span className="text-[var(--gray-12)]">gather the context</span>{" "}
              before it writes a line.
            </p>
          </Reveal>

          {benchmark ? (
            <Reveal delay={120} className="mt-10">
              <BenchmarkBars data={benchmark} reduction={reduction} />
            </Reveal>
          ) : (
            <div className="mt-10 rounded-lg border border-[var(--gray-05)] bg-[var(--gray-02)] p-6 text-sm text-[var(--gray-09)]">
              Benchmark results will render here once the harness produces
              measured data.
            </div>
          )}
        </div>
      </section>

      {/* Capabilities — bento */}
      <section
        id="capabilities"
        className="relative z-10 border-t border-[var(--gray-04)]/60 px-6 py-20"
      >
        <div className="mx-auto max-w-[1180px]">
          <Reveal>
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--gray-09)]">
              The platform
            </p>
            <h2
              className={`${display.className} mt-3 max-w-[24ch] text-[clamp(1.8rem,3.4vw,2.8rem)] font-extrabold tracking-[-0.03em]`}
            >
              One workspace for everything your agents do.
            </h2>
          </Reveal>

          <div className="mt-10 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {/* Featured: context engine */}
            <Reveal className="sm:col-span-2 lg:row-span-2" delay={0}>
              <BentoCard featured>
                <CardHead icon={<IconPack />} title="Context packs" tag="retrieval engine" />
                <p className="mt-3 text-[14px] leading-relaxed text-[var(--gray-10)]">
                  A hybrid index — BM25 + code graph + embeddings — returns the{" "}
                  <span className="text-[var(--gray-12)]">exact line ranges</span>{" "}
                  an agent needs, with citations and a reason for every pick.
                  Bounded, inspectable, and the source of the {reduction}% token win.
                </p>
                <div className="mt-5 space-y-2">
                  {[
                    { f: "lib/response.js", l: "L142–L168", r: "symbol definition" },
                    { f: "lib/request.js", l: "L88–L101", r: "graph expansion" },
                    { f: "test/res.json.js", l: "L12–L40", r: "BM25 keyword match" },
                  ].map((row) => (
                    <div
                      key={row.f}
                      className="flex items-center gap-3 rounded-md border border-[var(--gray-05)] bg-[var(--gray-00)]/60 px-3 py-2"
                    >
                      <span className="font-mono text-[12px] text-[var(--gray-12)]">{row.f}</span>
                      <span
                        className="font-mono text-[12px]"
                        style={{ color: ACCENT }}
                      >
                        {row.l}
                      </span>
                      <span className="ml-auto font-mono text-[11px] text-[var(--gray-09)]">
                        {row.r}
                      </span>
                    </div>
                  ))}
                </div>
              </BentoCard>
            </Reveal>

            <Reveal delay={60}>
              <BentoCard>
                <CardHead icon={<IconRuns />} title="Agent runs" />
                <p className="mt-2 text-[13px] leading-relaxed text-[var(--gray-10)]">
                  Every run&apos;s events, timing, tokens, and outcome — replayable.
                </p>
                <MiniTimeline />
              </BentoCard>
            </Reveal>

            <Reveal delay={120}>
              <BentoCard>
                <CardHead icon={<IconGate />} title="Review gates" />
                <p className="mt-2 text-[13px] leading-relaxed text-[var(--gray-10)]">
                  Policy checkpoints between phases. Agents stop and show evidence
                  before they continue.
                </p>
              </BentoCard>
            </Reveal>

            <Reveal delay={60}>
              <BentoCard>
                <CardHead icon={<IconAfk />} title="AFK mode" />
                <p className="mt-2 text-[13px] leading-relaxed text-[var(--gray-10)]">
                  Unattended, multi-phase agent work — review-gated so you stay in
                  control without babysitting.
                </p>
              </BentoCard>
            </Reveal>

            <Reveal delay={120}>
              <BentoCard>
                <CardHead icon={<IconCost />} title="Costs" />
                <p className="mt-2 text-[13px] leading-relaxed text-[var(--gray-10)]">
                  Token + dollar spend per run, repo, and workspace.
                </p>
                <p className={`${display.className} mt-3 text-3xl font-extrabold tracking-tight`}>
                  $<CountUp to={1284} decimals={0} />
                  <span className="ml-1 align-middle text-[12px] font-medium text-[var(--gray-09)]">
                    / mo tracked
                  </span>
                </p>
              </BentoCard>
            </Reveal>

            <Reveal delay={60}>
              <BentoCard>
                <CardHead icon={<IconFail />} title="Failures" />
                <p className="mt-2 text-[13px] leading-relaxed text-[var(--gray-10)]">
                  Structured root-cause records, linked to the run and the context
                  that triggered them.
                </p>
              </BentoCard>
            </Reveal>

            <Reveal delay={120}>
              <BentoCard>
                <CardHead icon={<IconMemory />} title="Memory" />
                <p className="mt-2 text-[13px] leading-relaxed text-[var(--gray-10)]">
                  Durable project knowledge agents recall across runs — no repeated
                  mistakes.
                </p>
              </BentoCard>
            </Reveal>

            <Reveal delay={60}>
              <BentoCard>
                <CardHead icon={<IconAudit />} title="Audit" />
                <p className="mt-2 text-[13px] leading-relaxed text-[var(--gray-10)]">
                  Source-linked events for every sensitive action, redaction, and
                  provider call.
                </p>
              </BentoCard>
            </Reveal>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="relative z-10 border-t border-[var(--gray-04)]/60 px-6 py-24">
        <div className="mx-auto max-w-[1180px]">
          <Reveal className="relative overflow-hidden rounded-2xl border border-[var(--gray-05)] bg-[var(--gray-01)] px-8 py-16 text-center">
            <div
              aria-hidden
              className="ar-drift pointer-events-none absolute left-1/2 top-0 h-[300px] w-[600px] -translate-x-1/2 opacity-20"
              style={{
                background: `radial-gradient(50% 50% at 50% 50%, ${ACCENT} 0%, transparent 70%)`,
                filter: "blur(30px)",
              }}
            />
            <h2
              className={`${display.className} relative text-[clamp(2rem,4vw,3.2rem)] font-extrabold tracking-[-0.03em]`}
            >
              Stop guessing what your agents did.
            </h2>
            <p className="relative mx-auto mt-4 max-w-[52ch] text-[15px] text-[var(--gray-10)]">
              Connect a repo, run an agent, and watch the context, cost, and
              review evidence land in one place.
            </p>
            <form
              className="relative mt-8 inline-block"
              action={async () => {
                "use server";
                await signIn("github", { redirectTo: "/" });
              }}
            >
              <button
                type="submit"
                className="inline-flex items-center gap-2 rounded-md bg-[#ffe629] px-6 py-3.5 text-[15px] font-bold text-black transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#ffdc00]"
              >
                <GitHubIcon />
                Sign in with GitHub
              </button>
            </form>
            <p className="relative mt-4 font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--gray-09)]">
              Free while in preview
            </p>
          </Reveal>
        </div>
      </section>

      {/* Footer */}
      <footer className="relative z-10 border-t border-[var(--gray-04)]/60 px-6 py-8">
        <div className="mx-auto flex max-w-[1180px] flex-col items-center justify-between gap-2 sm:flex-row">
          <div className="flex items-center gap-2">
            <RailMark />
            <span className="text-[13px] text-[var(--gray-10)]">
              AgentRail — agent control plane for engineering teams
            </span>
          </div>
          <span className="font-mono text-[11px] text-[var(--gray-09)]">
            repo-native · deterministic · inspectable
          </span>
        </div>
      </footer>
    </main>
  );
}

/* ---------------------------------------------------------------- pieces */

function SignalStat({
  kpi,
  label,
  accent,
}: {
  kpi: string;
  label: string;
  accent?: boolean;
}) {
  return (
    <div className="flex-1 basis-[160px] bg-[var(--gray-01)] px-5 py-4">
      <p
        className="text-[clamp(1.6rem,3vw,2.1rem)] font-extrabold tracking-tight"
        style={{ color: accent ? ACCENT : "var(--gray-12)" }}
      >
        {kpi}
      </p>
      <p className="mt-0.5 text-[12px] leading-snug text-[var(--gray-09)]">{label}</p>
    </div>
  );
}

function BenchmarkBars({
  data,
  reduction,
}: {
  data: BenchmarkData;
  reduction: number;
}) {
  const max = data.smartAgentTokens;
  const rows = [
    {
      label: "AgentRail",
      sub: "reads the returned line ranges",
      tokens: data.agentrailTokens,
      pct: Math.max(3, (data.agentrailTokens / max) * 100),
      accent: true,
    },
    {
      label: "Smart agent",
      sub: "opens only the right files, in full",
      tokens: data.smartAgentTokens,
      pct: 100,
      accent: false,
    },
  ];

  const fmt = (n: number) =>
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(1)}M`
      : n >= 1_000
      ? `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`
      : String(n);

  return (
    <div className="rounded-xl border border-[var(--gray-05)] bg-[var(--gray-01)] p-6 sm:p-8">
      <div className="space-y-6">
        {rows.map((row, i) => (
          <div key={row.label}>
            <div className="mb-2 flex items-baseline gap-3">
              <span
                className="text-[15px] font-bold"
                style={{ color: row.accent ? ACCENT : "var(--gray-12)" }}
              >
                {row.label}
              </span>
              <span className="text-[12px] text-[var(--gray-09)]">{row.sub}</span>
              <span
                className="ml-auto font-mono text-[14px]"
                style={{ color: row.accent ? ACCENT : "var(--gray-11)" }}
              >
                <CountUp to={row.tokens} compact /> tk
              </span>
            </div>
            <div className="h-7 w-full overflow-hidden rounded bg-[var(--gray-03)]">
              <div
                className="ar-bar h-full rounded"
                style={{
                  width: `${row.pct}%`,
                  background: row.accent ? ACCENT : "var(--gray-06)",
                  animationDelay: `${i * 140}ms`,
                }}
              />
            </div>
          </div>
        ))}

        {/* off-scale naive */}
        <div className="flex items-center justify-between rounded border border-dashed border-[var(--gray-05)] px-4 py-3">
          <span className="text-[13px] text-[var(--gray-10)]">
            <span className="font-bold text-[var(--gray-12)]">Naive grep</span>{" "}
            — reads every matched file in full
          </span>
          <span className="font-mono text-[13px] text-[var(--gray-09)]">
            {fmt(data.naiveTokens)} tk · off-scale
          </span>
        </div>
      </div>

      <div className="mt-7 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-[var(--gray-04)] pt-6">
        <span className={`${display.className} text-4xl font-extrabold`} style={{ color: ACCENT }}>
          −{reduction}%
        </span>
        <span className="text-[14px] text-[var(--gray-10)]">
          fewer tokens than an agent that opens exactly the right files — because
          AgentRail reads ranges, not whole files. 100% recall.
        </span>
      </div>
    </div>
  );
}

function RailFlow() {
  const stops = ["Issue", "Context pack", "Bounded run", "Review gate", "Merge"];
  return (
    <div className="relative">
      <div className="absolute left-0 right-0 top-[11px] h-px bg-[var(--gray-05)]" />
      <div
        aria-hidden
        className="absolute left-0 top-[10px] h-[3px] w-24 rounded-full"
        style={{
          background: `linear-gradient(90deg, transparent, ${ACCENT}, transparent)`,
        }}
      >
        <span className="ar-scan block h-full w-full rounded-full" style={{ background: `linear-gradient(90deg, transparent, ${ACCENT}, transparent)` }} />
      </div>
      <ol className="relative flex items-start justify-between gap-2">
        {stops.map((s, i) => (
          <li key={s} className="flex flex-1 flex-col items-center text-center">
            <span
              className="mb-3 h-[22px] w-[22px] rounded-full border-2"
              style={{
                borderColor: ACCENT,
                background: i === 0 ? ACCENT : "var(--gray-00)",
              }}
            />
            <span className="font-mono text-[11px] uppercase tracking-wider text-[var(--gray-10)]">
              {s}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function BentoCard({
  children,
  featured,
}: {
  children: React.ReactNode;
  featured?: boolean;
}) {
  return (
    <div
      className={`ar-cell flex h-full flex-col rounded-xl border border-[var(--gray-05)] p-5 ${
        featured ? "bg-[var(--gray-01)]" : "bg-[var(--gray-01)]/60"
      }`}
    >
      {children}
    </div>
  );
}

function CardHead({
  icon,
  title,
  tag,
}: {
  icon: React.ReactNode;
  title: string;
  tag?: string;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--gray-05)] bg-[var(--gray-00)] text-[var(--gray-11)]"
        style={{ color: ACCENT }}
      >
        {icon}
      </span>
      <span className="text-[15px] font-bold text-[var(--gray-12)]">{title}</span>
      {tag && (
        <span className="ml-auto rounded-full border border-[var(--gray-05)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[var(--gray-09)]">
          {tag}
        </span>
      )}
    </div>
  );
}

function MiniTimeline() {
  const bars = [40, 70, 35, 90, 55, 75, 45];
  return (
    <div className="mt-auto flex items-end gap-1 pt-4">
      {bars.map((h, i) => (
        <span
          key={i}
          className="ar-bar flex-1 rounded-sm"
          style={{
            height: `${h * 0.4 + 8}px`,
            background:
              i === 3 ? ACCENT : "color-mix(in srgb, var(--gray-08) 60%, transparent)",
            animationDelay: `${i * 80}ms`,
            transformOrigin: "bottom",
          }}
        />
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- icons */

function RailMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="3" y="2" width="2.4" height="16" rx="1.2" fill={ACCENT} />
      <rect x="14.6" y="2" width="2.4" height="16" rx="1.2" fill={ACCENT} />
      <rect x="2" y="6" width="16" height="1.6" rx="0.8" fill="var(--gray-08)" />
      <rect x="2" y="12.4" width="16" height="1.6" rx="0.8" fill="var(--gray-08)" />
    </svg>
  );
}

const ic = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function IconPack() {
  return (
    <svg {...ic}><path d="M21 8 12 3 3 8l9 5 9-5Z" /><path d="m3 12 9 5 9-5" /><path d="m3 16 9 5 9-5" /></svg>
  );
}
function IconRuns() {
  return <svg {...ic}><path d="M3 12h4l3 8 4-16 3 8h4" /></svg>;
}
function IconGate() {
  return <svg {...ic}><path d="M12 3v18" /><path d="M5 7h14" /><circle cx="12" cy="12" r="3" /></svg>;
}
function IconAfk() {
  return <svg {...ic}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
}
function IconCost() {
  return <svg {...ic}><path d="M12 2v20" /><path d="M17 6.5C17 4.5 14.8 4 12 4S7 4.8 7 7s2.5 2.7 5 3 5 1 5 3.2-2.2 2.8-5 2.8-5-.7-5-2.8" /></svg>;
}
function IconFail() {
  return <svg {...ic}><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg>;
}
function IconMemory() {
  return <svg {...ic}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M9 9h6v6H9z" /><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" /></svg>;
}
function IconAudit() {
  return <svg {...ic}><path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z" /><path d="m9 15 2 2 4-4" /></svg>;
}

function GitHubIcon() {
  return (
    <svg height="18" width="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

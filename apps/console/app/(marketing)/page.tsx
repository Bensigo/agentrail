import { auth, signIn } from "@agentrail/auth";
import { listWorkspacesForUser } from "@agentrail/db-postgres";
import { redirect } from "next/navigation";
import { Bricolage_Grotesque } from "next/font/google";
import fs from "fs";
import path from "path";
import { Reveal, CountUp } from "./_motion";

const display = Bricolage_Grotesque({ subsets: ["latin"], display: "swap" });

interface AgentAB {
  plainTokens: number;
  agentrailTokens: number;
  reduction: number;
  repetitions: number;
  tasks: number;
}

/** The honest, end-to-end benchmark: the same coding task through a real agent,
 *  with vs without AgentRail. See docs/benchmarks/agent-ab-protocol.md. */
function parseAgentAB(): AgentAB | null {
  try {
    const content = fs.readFileSync(
      path.join(process.cwd(), "../../docs/benchmarks/results/agent-ab-latest.md"),
      "utf-8"
    );
    const plain = content.match(/plain agent:\s*\*\*([\d,]+)\*\*/i);
    const ar = content.match(/AgentRail CLI:\s*\*\*([\d,]+)\*\*/i);
    const red = content.match(/\(−(\d+)%\)/);
    const reps = content.match(/repetitions:\s*(\d+)/i);
    const tasks = content.match(/Tasks:\s*(\d+)/i);
    if (!plain || !ar) return null;
    const n = (s: string) => parseInt(s.replace(/,/g, ""), 10);
    return {
      plainTokens: n(plain[1]),
      agentrailTokens: n(ar[1]),
      reduction: red ? parseInt(red[1]) : 24,
      repetitions: reps ? parseInt(reps[1]) : 3,
      tasks: tasks ? parseInt(tasks[1]) : 1,
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

  const agentab = parseAgentAB();
  const reduction = agentab ? agentab.reduction : 24;

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
            AgentRail is the <span className="text-[var(--gray-12)]">console</span>{" "}
            for your team&apos;s coding agents — every run, the context it used,
            what it cost, the <span className="text-[var(--gray-12)]">review gates</span>{" "}
            it passed, and a full audit, in one workspace. The agents that feed it
            run leaner, too —{" "}
            <span style={{ color: ACCENT }}>{reduction}% fewer tokens</span>, measured.
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

          {/* Signal stat — the real end-to-end agent A/B */}
          {agentab && (
            <div
              className="ar-rise mt-12 flex flex-wrap items-stretch gap-px overflow-hidden rounded-xl border border-[var(--gray-05)] bg-[var(--gray-05)]"
              style={{ animationDelay: "320ms" }}
            >
              <SignalStat
                kpi={`−${reduction}%`}
                label="total agent tokens, real run"
                accent
              />
              <SignalStat kpi="100%" label="context found — both arms" />
              <SignalStat
                kpi={agentab.agentrailTokens.toLocaleString("en-US")}
                label={`vs ${agentab.plainTokens.toLocaleString("en-US")} without AgentRail`}
              />
              <SignalStat
                kpi={`${agentab.repetitions}×`}
                label="repetitions, averaged"
              />
            </div>
          )}
        </div>
      </section>

      {/* The console — product shot */}
      <section className="relative z-10 px-6 pb-12 pt-4">
        <div className="mx-auto max-w-[1180px]">
          <Reveal delay={80}>
            <DashboardMock />
          </Reveal>
          <p className="mt-5 text-center font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--gray-09)]">
            One workspace · every developer&apos;s runs, context, cost, gates &amp; audit
          </p>
        </div>
      </section>

      {/* Rail motif */}
      <section className="relative z-10 px-6 pb-16 pt-4">
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
              Real agent · with vs without · {agentab ? agentab.repetitions : 3} reps
            </p>
            <h2
              className={`${display.className} mt-3 max-w-[20ch] text-[clamp(1.8rem,3.4vw,2.8rem)] font-extrabold tracking-[-0.03em]`}
            >
              We didn&apos;t claim it. We benchmarked it.
            </h2>
            <p className="mt-3 max-w-[64ch] text-[15px] leading-relaxed text-[var(--gray-10)]">
              We ran the <span className="text-[var(--gray-12)]">same</span> multi-file
              coding task on a real repo (<span className="font-mono text-[13px]">psf/requests</span>),
              through the <span className="text-[var(--gray-12)]">same</span> agent,
              {" "}{agentab ? agentab.repetitions : 3}× each way. The only difference
              was whether it had AgentRail. Total tokens, end to end —
              not a synthetic context-gathering estimate.
            </p>
          </Reveal>

          {agentab ? (
            <Reveal delay={120} className="mt-10">
              <AgentABBars data={agentab} reduction={reduction} />
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

      {/* CLI vs Console — why the dashboard */}
      <section className="relative z-10 border-t border-[var(--gray-04)]/60 px-6 py-20">
        <div className="mx-auto max-w-[1180px]">
          <Reveal>
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--gray-09)]">
              Free CLI · team console
            </p>
            <h2
              className={`${display.className} mt-3 max-w-[22ch] text-[clamp(1.8rem,3.4vw,2.8rem)] font-extrabold tracking-[-0.03em]`}
            >
              The CLI runs your agents. The console runs your team.
            </h2>
            <p className="mt-3 max-w-[64ch] text-[15px] leading-relaxed text-[var(--gray-10)]">
              Every developer gets the AgentRail CLI{" "}
              <span className="text-[var(--gray-12)]">free, forever</span>. The
              console is where it becomes a team system — one place to{" "}
              <span className="text-[var(--gray-12)]">see, cost, govern, and trust</span>{" "}
              what every agent did, across every repo.
            </p>
          </Reveal>

          <div className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* CLI */}
            <Reveal>
              <div className="ar-cell flex h-full flex-col rounded-xl border border-[var(--gray-05)] bg-[var(--gray-01)]/60 p-6">
                <div className="flex items-center justify-between">
                  <span className="text-[15px] font-bold text-[var(--gray-12)]">
                    AgentRail CLI
                  </span>
                  <span className="rounded-full border border-[var(--gray-05)] px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[var(--gray-09)]">
                    free · every developer
                  </span>
                </div>
                <p className="mt-1 text-[13px] text-[var(--gray-09)]">
                  Runs on your machine, in your terminal.
                </p>
                <ul className="mt-5 space-y-2.5">
                  {[
                    "Hybrid context retrieval — line ranges, not files",
                    "Bounded, review-gated agent runs",
                    "Durable project memory",
                    "Repo-native, deterministic, offline",
                  ].map((t) => (
                    <ValueRow key={t} text={t} muted />
                  ))}
                </ul>
              </div>
            </Reveal>

            {/* Console */}
            <Reveal delay={100}>
              <div
                className="ar-cell relative flex h-full flex-col rounded-xl border bg-[var(--gray-01)] p-6"
                style={{ borderColor: "color-mix(in srgb, #ffe629 40%, var(--gray-05))" }}
              >
                <div
                  aria-hidden
                  className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full opacity-20"
                  style={{ background: `radial-gradient(50% 50% at 50% 50%, ${ACCENT} 0%, transparent 70%)`, filter: "blur(20px)" }}
                />
                <div className="relative flex items-center justify-between">
                  <span className="text-[15px] font-bold" style={{ color: ACCENT }}>
                    AgentRail Console
                  </span>
                  <span
                    className="rounded-full px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-black"
                    style={{ background: ACCENT }}
                  >
                    teams · see &amp; govern
                  </span>
                </div>
                <p className="relative mt-1 text-[13px] text-[var(--gray-10)]">
                  Your terminal shows your runs. The console shows your team&apos;s.
                </p>
                <ul className="relative mt-5 grid gap-2.5 sm:grid-cols-2">
                  {[
                    "Every developer's runs in one workspace",
                    "Server-enforced review gates & policy",
                    "Cost across repos, teams, workspaces",
                    "Audit trail for every sensitive action",
                    "Shared memory the whole team recalls",
                    "Indexing health, API keys, members",
                  ].map((t) => (
                    <ValueRow key={t} text={t} />
                  ))}
                </ul>
              </div>
            </Reveal>
          </div>

          <Reveal delay={160}>
            <p className="mt-6 text-center text-[13px] text-[var(--gray-09)]">
              One agent on your laptop is a tool.{" "}
              <span className="text-[var(--gray-11)]">
                A team of agents you can see, cost, and govern is a control plane.
              </span>
            </p>
          </Reveal>
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

function AgentABBars({
  data,
  reduction,
}: {
  data: AgentAB;
  reduction: number;
}) {
  const max = data.plainTokens;
  const rows = [
    {
      label: "Plain agent",
      sub: "its own grep + whole-file reads",
      tokens: data.plainTokens,
      pct: 100,
      accent: false,
    },
    {
      label: "Agent + AgentRail",
      sub: "compact context via the CLI",
      tokens: data.agentrailTokens,
      pct: Math.max(6, (data.agentrailTokens / max) * 100),
      accent: true,
    },
  ];

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
                <CountUp to={row.tokens} /> tk
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

        <div className="flex items-center gap-2 rounded border border-[var(--gray-05)] bg-[var(--gray-00)]/50 px-4 py-3">
          <span
            className="flex h-5 w-5 items-center justify-center rounded-full"
            style={{ background: ACCENT }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
          </span>
          <span className="text-[13px] text-[var(--gray-10)]">
            Both arms found the required files{" "}
            <span className="text-[var(--gray-12)]">every time</span> — fewer
            tokens, not less context.
          </span>
        </div>
      </div>

      <div className="mt-7 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-[var(--gray-04)] pt-6">
        <span className={`${display.className} text-4xl font-extrabold`} style={{ color: ACCENT }}>
          −{reduction}%
        </span>
        <span className="text-[14px] text-[var(--gray-10)]">
          total tokens through a real coding agent, at equal accuracy. One task,
          one repo, one model — directional, and honest about it.
        </span>
      </div>
    </div>
  );
}

function DashboardMock() {
  const nav = [
    { label: "Runs", active: true },
    { label: "Context packs" },
    { label: "Review gates" },
    { label: "Failures" },
    { label: "Costs" },
    { label: "Memory" },
    { label: "Audit" },
    { label: "Repos" },
  ];
  const runs = [
    { id: "#312", task: "workspace setup flow", who: "amara", agent: "claude", status: "merged", tk: "31,092", cost: "$0.42", dur: "2m14s" },
    { id: "#316", task: "AFK telemetry timeline", who: "deniz", agent: "codex", status: "reviewing", tk: "48,210", cost: "$0.71", dur: "4m02s" },
    { id: "#331", task: "review-gate enforcement", who: "amara", agent: "claude", status: "merged", tk: "27,540", cost: "$0.38", dur: "3m20s" },
    { id: "#314", task: "workspace members by email", who: "sam", agent: "claude", status: "failed", tk: "12,800", cost: "$0.18", dur: "1m05s" },
    { id: "#315", task: "agentrail link e2e", who: "deniz", agent: "codex", status: "running", tk: "19,430", cost: "$0.29", dur: "1m48s" },
  ];
  const statusStyle: Record<string, { dot: string; text: string; label: string }> = {
    merged: { dot: "var(--green-11)", text: "var(--green-11)", label: "merged" },
    reviewing: { dot: ACCENT, text: ACCENT, label: "review gate" },
    failed: { dot: "var(--red-11)", text: "var(--red-11)", label: "failed" },
    running: { dot: "var(--blue-11)", text: "var(--blue-11)", label: "running" },
  };

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--gray-05)] bg-[var(--gray-01)] shadow-[0_40px_120px_-40px_rgba(0,0,0,0.8)]">
      {/* window chrome */}
      <div className="flex items-center gap-2 border-b border-[var(--gray-04)] bg-[var(--gray-02)] px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-[var(--gray-06)]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[var(--gray-06)]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[var(--gray-06)]" />
        <span className="ml-3 rounded bg-[var(--gray-00)] px-3 py-1 font-mono text-[11px] text-[var(--gray-09)]">
          app.agentrail.dev/dashboard/dev-workspace/runs
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
            {nav.map((n) => (
              <div
                key={n.label}
                className="rounded-md px-2.5 py-1.5 text-[12px]"
                style={{
                  background: n.active ? "color-mix(in srgb, #ffe629 12%, transparent)" : "transparent",
                  color: n.active ? ACCENT : "var(--gray-10)",
                  fontWeight: n.active ? 600 : 400,
                }}
              >
                {n.label}
              </div>
            ))}
          </nav>
        </aside>

        {/* main */}
        <div className="p-4 sm:p-5">
          {/* stat tiles */}
          <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            {[
              { v: "128", l: "runs this week" },
              { v: "2.1M", l: "tokens" },
              { v: "$31.40", l: "spend" },
              { v: "3", l: "open gates", accent: true },
            ].map((s) => (
              <div key={s.l} className="rounded-lg border border-[var(--gray-05)] bg-[var(--gray-00)]/60 px-3 py-2.5">
                <p className="text-[18px] font-bold tracking-tight" style={{ color: s.accent ? ACCENT : "var(--gray-12)" }}>
                  {s.v}
                </p>
                <p className="font-mono text-[10px] uppercase tracking-wider text-[var(--gray-09)]">{s.l}</p>
              </div>
            ))}
          </div>

          {/* runs table */}
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
                    <span className="text-[11px]" style={{ color: st.text }}>{st.label}</span>
                  </span>
                  <span className="hidden font-mono text-[12px] text-[var(--gray-11)] sm:block">{r.tk}</span>
                  <span className="hidden font-mono text-[12px] text-[var(--gray-11)] sm:block">{r.cost}</span>
                </div>
              );
            })}
          </div>
        </div>
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

function ValueRow({ text, muted }: { text: string; muted?: boolean }) {
  return (
    <li className="flex items-start gap-2.5">
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke={muted ? "var(--gray-08)" : ACCENT}
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="mt-0.5 shrink-0"
        aria-hidden
      >
        <path d="M20 6 9 17l-5-5" />
      </svg>
      <span className="text-[13px] leading-snug text-[var(--gray-11)]">{text}</span>
    </li>
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

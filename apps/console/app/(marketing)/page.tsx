import { auth, signIn } from "@agentrail/auth";
import { listWorkspacesForUser, claimInvitesForUser } from "@agentrail/db-postgres";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Bricolage_Grotesque } from "next/font/google";
import { Reveal, CountUp } from "./_motion";
import { DashboardDemo } from "./_dashboard-demo";

const display = Bricolage_Grotesque({ subsets: ["latin"], display: "swap" });

/** Real dogfood track record — full autonomous runs of AgentRail on its own
 *  backlog (issue → implementation → review → PR), not a retrieval benchmark.
 *  Source: docs/benchmarks/results/dogfood-track-record.md. */
const TRACK_RECORD = {
  shipped: 33,
  attempted: 53,
  failed: 20,
  sample: { issue: 221, title: "Add API keys view", pr: 308 },
};

const ACCENT = "#ffe629";

const STEPS = [
  {
    n: "01",
    title: "Point it at your repo",
    cmd: "agentrail init",
    desc: "One command builds a local index of your codebase — BM25 and a code graph. Repo-native; nothing leaves your machine to retrieve context.",
  },
  {
    n: "02",
    title: "Agents run on compiled context",
    cmd: "agentrail run",
    desc: "Instead of whole files, agents pull bounded line-range context packs with a cited reason per pick — the source of the measured token win.",
  },
  {
    n: "03",
    title: "Gate and review",
    cmd: "review gates",
    desc: "Policy checkpoints stop agents between phases to show evidence. AFK mode runs unattended work that stays inside the gates.",
  },
  {
    n: "04",
    title: "See it in the console",
    cmd: "→ dashboard",
    desc: "Every run, context pack, cost, failure, and audit event lands in one team workspace — searchable, replayable, and governed.",
  },
];

/** Why it's safe to walk away — value/outcome first, mechanism only as support. */
const VALUE = [
  {
    title: "Clear the backlog, not your calendar",
    desc: "Point it at your GitHub or Linear issues and they're worked overnight in an isolated sandbox. You review PRs in the morning — you never sit and babysit a run.",
  },
  {
    title: "Trust the work without watching it",
    desc: "Nothing counts as done until a second model and your own tests both agree. The agent never grades its own work, and nothing merges on its say-so.",
  },
  {
    title: "Never get a surprise bill",
    desc: "Every issue runs under a hard budget — cheap models first, escalating only when it must, then stopping to a human. Your spend can't run away.",
  },
];

const FAQS = [
  {
    q: "What does the console give me that the free CLI doesn't?",
    a: "The CLI is one developer's terminal. The console is the team system: every developer's runs in one workspace, the issue queue and its budget leash, cost across repos and teams, a full audit trail, and member management — the things you can only do when agent work is centralized.",
  },
  {
    q: "How do my team's agent runs get into the console?",
    a: "Connect the CLI to your workspace with a key, and runs stream in automatically — each one's context packs, token and dollar cost, review-gate evidence, and outcome land in the dashboard with no extra steps.",
  },
  {
    q: "Can I invite my team and control who sees what?",
    a: "Yes. Invite teammates by email during setup or from the Members page; an invite is accepted automatically the next time they sign in. Roles — owner, admin, member — govern who can invite people, configure review gates, and manage repositories.",
  },
  {
    q: "Does the console store my source code?",
    a: "No. Indexing stays local on each developer's machine. The console stores run metadata, context-pack citations (line ranges, not file contents), costs, and audit events — not your source by default.",
  },
  {
    q: "What can I actually govern from the console?",
    a: "Server-enforced review gates and policy across every repo — require context-pack evidence before a run can merge, see and cap spend per repo and team, and get a source-linked audit trail for every sensitive action an agent takes.",
  },
  {
    q: "Is the CLI still free, and how does the console price?",
    a: "The CLI is free forever for every developer. The console is the team layer and is free while in preview — so you can connect a repo, invite your team, and see every agent's work in one place today.",
  },
];

export default async function LandingPage() {
  const session = await auth();
  if (session?.user?.id) {
    const email = (session.user as typeof session.user & { email?: string }).email;
    if (email) {
      try {
        await claimInvitesForUser({ userId: session.user.id, email });
      } catch {
        // never block login
      }
    }
    const workspaces = await listWorkspacesForUser(session.user.id);
    redirect(workspaces.length > 0 ? `/dashboard/${workspaces[0].id}` : "/setup");
  }

  const track = TRACK_RECORD;

  return (
    <main id="top" className="relative min-h-screen bg-[var(--gray-00)] text-[var(--gray-12)]">
      {/* Nav — hairline rule, wordmark left, links + one primary CTA right */}
      <header className="sticky top-0 z-30 border-b border-[var(--gray-04)] bg-[var(--gray-00)]/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-[1180px] items-center justify-between px-6">
          <a href="#top" className="flex items-center gap-2.5">
            <RailMark />
            <span className={`${display.className} text-[15px] font-extrabold tracking-tight`}>
              AgentRail
            </span>
          </a>
          <nav className="flex items-center gap-1">
            <a
              href="#how"
              className="hidden rounded px-3 py-1.5 text-[13px] text-[var(--gray-10)] transition-colors hover:text-[var(--gray-12)] sm:block"
            >
              How it works
            </a>
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
            <Link
              href="/docs"
              className="rounded px-3 py-1.5 text-[13px] text-[var(--gray-10)] transition-colors hover:text-[var(--gray-12)]"
            >
              Docs
            </Link>
            <form
              action={async () => {
                "use server";
                await signIn("github", { redirectTo: "/" });
              }}
              className="ml-1 flex items-center gap-1"
            >
              <button
                type="submit"
                className="hidden rounded px-3 py-1.5 text-[13px] font-medium text-[var(--gray-11)] transition-colors hover:text-[var(--gray-12)] sm:block"
              >
                Sign in
              </button>
              <button
                type="submit"
                className="rounded-md bg-[var(--gray-12)] px-3.5 py-1.5 text-[13px] font-semibold text-[var(--gray-00)] transition-opacity hover:opacity-90"
              >
                Start free
              </button>
            </form>
          </nav>
        </div>
      </header>

      {/* Hero — minimal left-aligned copy; product framed on an atmospheric backdrop */}
      <section className="relative overflow-hidden px-6 pb-0 pt-12 sm:pt-14">
        <div className="relative z-10 mx-auto max-w-[1180px]">
          <h1
            className={`${display.className} ar-rise max-w-[20ch] text-balance text-[clamp(1.65rem,2.8vw,2.5rem)] font-extrabold leading-[1.05] tracking-[-0.035em]`}
          >
            Turn your backlog into reviewed PRs.
          </h1>

          <p
            className="ar-rise mt-4 max-w-[44ch] text-[clamp(0.95rem,1.4vw,1.1rem)] leading-relaxed text-[var(--gray-10)]"
            style={{ animationDelay: "80ms" }}
          >
            Your coding agents, running overnight on rails — for fewer tokens,
            independently reviewed, and never off the rails.
          </p>

          <div
            className="ar-rise mt-6 flex flex-wrap items-center gap-3"
            style={{ animationDelay: "160ms" }}
          >
            <form
              action={async () => {
                "use server";
                await signIn("github", { redirectTo: "/" });
              }}
            >
              <button
                type="submit"
                className="group inline-flex items-center gap-2 rounded-md bg-[#ffe629] px-5 py-3 text-[15px] font-bold text-black transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#ffdc00]"
              >
                <GitHubIcon />
                Start free
              </button>
            </form>
            <a
              href="#how"
              className="inline-flex items-center gap-2 rounded-md border border-[var(--gray-05)] px-5 py-3 text-[15px] font-medium text-[var(--gray-11)] transition-colors hover:border-[var(--gray-07)] hover:text-[var(--gray-12)]"
            >
              See how it works <span aria-hidden>→</span>
            </a>
          </div>

          <p
            className="ar-rise mt-4 text-[12px] text-[var(--gray-09)]"
            style={{ animationDelay: "200ms" }}
          >
            Free in preview · {track.shipped} issues shipped on our own backlog
          </p>
        </div>

        {/* Product framed on an atmospheric backdrop — the "pop" */}
        <div className="relative mt-9 sm:mt-12">
          {/* full-bleed painterly wash: cool top → warm horizon, so the dark
              window floats in a pool of light (the Cursor/Devin effect). */}
          {/* atmospheric pool — bounded to the content column (aligned with the
              hero text edges), cool top → warm horizon, rounded and contained. */}
          <div
            aria-hidden
            className="pointer-events-none absolute left-0 right-0 top-[-80px] bottom-[-32px] mx-auto max-w-[1180px] overflow-hidden rounded-[28px]"
            style={{
              background:
                "radial-gradient(62% 90% at 50% 0%, rgba(132,162,202,0.16), transparent 68%), radial-gradient(58% 64% at 50% 52%, rgba(255,198,126,0.24), transparent 66%), linear-gradient(180deg, rgba(34,40,54,0) 0%, rgba(50,54,62,0.5) 18%, rgba(80,68,46,0.6) 50%, rgba(46,36,24,0.45) 78%, rgba(8,8,8,0) 100%)",
            }}
          />

          <div className="relative z-10 mx-auto max-w-[1120px]">
            <Reveal delay={120}>
              <div className="relative">
                <DashboardDemo />

                {/* floating CLI surface, layered over the console */}
                <div
                  aria-hidden
                  className="pointer-events-none absolute -bottom-7 -right-3 hidden w-[330px] overflow-hidden rounded-lg border border-[var(--gray-06)] bg-[var(--gray-00)] shadow-[0_36px_90px_-24px_rgba(0,0,0,0.95)] lg:block"
                >
                  <div className="flex items-center gap-1.5 border-b border-[var(--gray-05)] bg-[var(--gray-02)] px-3 py-2">
                    <span className="h-2 w-2 rounded-full bg-[var(--gray-06)]" />
                    <span className="h-2 w-2 rounded-full bg-[var(--gray-06)]" />
                    <span className="h-2 w-2 rounded-full bg-[var(--gray-06)]" />
                    <span className="ml-2 font-mono text-[10px] text-[var(--gray-09)]">
                      agentrail CLI
                    </span>
                  </div>
                  <div className="space-y-1.5 p-3.5 font-mono text-[11px] leading-relaxed">
                    <p className="text-[var(--gray-11)]">$ agentrail run #316</p>
                    <p className="text-[var(--gray-10)]">
                      <span style={{ color: ACCENT }}>▸</span> context pack · 4 files, 218 lines
                    </p>
                    <p className="text-[var(--gray-10)]">
                      <span style={{ color: ACCENT }}>▸</span> verify · independent model{" "}
                      <span className="text-[#1fd8a4]">✓</span>
                    </p>
                    <p className="text-[var(--gray-10)]">
                      <span style={{ color: ACCENT }}>▸</span> gate · tests 142 passed
                    </p>
                    <p className="text-[#1fd8a4]">✓ green — opened PR #421</p>
                  </div>
                </div>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* How it works — STEP 01–04 */}
      <section
        id="how"
        className="relative z-10 border-t border-[var(--gray-04)]/60 px-6 py-20"
      >
        <div className="mx-auto max-w-[1180px]">
          <Reveal>
            <h2
              className={`${display.className} max-w-[22ch] text-[clamp(1.7rem,3vw,2.5rem)] font-extrabold tracking-[-0.03em]`}
            >
              From{" "}
              <span className="font-mono text-[0.78em]" style={{ color: ACCENT }}>
                agentrail&nbsp;init
              </span>{" "}
              to a governed team.
            </h2>
          </Reveal>

          <div className="mt-12 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s, i) => (
              <Reveal key={s.n} delay={i * 80}>
                <Step n={s.n} title={s.title} desc={s.desc} cmd={s.cmd} />
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Proof / benchmark */}
      <section
        id="proof"
        className="relative z-10 border-t border-[var(--gray-04)]/60 px-6 py-20"
      >
        <div className="mx-auto max-w-[1180px]">
          <Reveal>
            <h2
              className={`${display.className} max-w-[20ch] text-[clamp(1.7rem,3vw,2.5rem)] font-extrabold tracking-[-0.03em]`}
            >
              We ran it on our own backlog.
            </h2>
            <p className="mt-3 max-w-[58ch] text-[15px] leading-relaxed text-[var(--gray-10)]">
              AgentRail has been shipping its own issues, unattended — full runs
              from open issue to a reviewed PR. Here&apos;s the real tally, the
              ones it landed and the ones it didn&apos;t.
            </p>
          </Reveal>

          <Reveal delay={120} className="mt-10">
            <TrackRecord data={track} />
          </Reveal>
        </div>
      </section>

      {/* Platform — verified capabilities, leads with the loop */}
      <section
        id="capabilities"
        className="relative z-10 border-t border-[var(--gray-04)]/60 px-6 py-20"
      >
        <div className="mx-auto max-w-[1180px]">
          <Reveal>
            <h2
              className={`${display.className} max-w-[20ch] text-[clamp(1.8rem,3.4vw,2.8rem)] font-extrabold tracking-[-0.03em]`}
            >
              Built to run without you.
            </h2>
            <p className="mt-4 max-w-[58ch] text-[15px] leading-relaxed text-[var(--gray-10)]">
              Hand it an issue and walk away — a reviewed PR comes back, your
              budget intact, with nothing merged on the agent&apos;s own say-so.
              Here&apos;s what makes that safe:
            </p>
          </Reveal>

          {/* Three reasons it's safe to walk away — value, not mechanism */}
          <div className="mt-10 grid gap-4 border-t border-[var(--gray-04)] pt-10 lg:grid-cols-3">
            {VALUE.map((b, i) => (
              <Reveal key={b.title} delay={(i % 3) * 80}>
                <div className="ar-cell flex h-full flex-col rounded-xl border border-[var(--gray-05)] bg-[var(--gray-01)]/60 p-6">
                  <h3
                    className={`${display.className} text-[1.2rem] font-bold leading-snug tracking-[-0.01em] text-[var(--gray-12)]`}
                  >
                    {b.title}
                  </h3>
                  <p className="mt-3 text-[13.5px] leading-relaxed text-[var(--gray-10)]">
                    {b.desc}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>

          {/* Deep dive — the compiled context behind "implement" */}
          <Reveal>
            <div className="mt-16 grid items-start gap-8 border-t border-[var(--gray-04)] pt-12 lg:grid-cols-[0.85fr_1.15fr] lg:gap-12">
              <div>
                <span className="text-[var(--gray-08)]">
                  <IconPack />
                </span>
                <h3 className={`${display.className} mt-3 text-[clamp(1.4rem,2.4vw,1.95rem)] font-bold tracking-[-0.02em]`}>
                  Pay for the lines that matter, not the whole repo.
                </h3>
                <p className="mt-3 max-w-[44ch] text-[14px] leading-relaxed text-[var(--gray-10)]">
                  Your agents read the{" "}
                  <span className="text-[var(--gray-12)]">exact lines</span> they
                  need — cited, and only those — instead of whole files. Far
                  fewer tokens per run, same result.
                </p>
              </div>
              <div className="space-y-2">
                {[
                  { f: "lib/response.js", l: "L142–L168", r: "symbol definition" },
                  { f: "lib/request.js", l: "L88–L101", r: "graph expansion" },
                  { f: "test/res.json.js", l: "L12–L40", r: "BM25 keyword match" },
                ].map((row) => (
                  <div
                    key={row.f}
                    className="flex items-center gap-3 rounded-md border border-[var(--gray-05)] bg-[var(--gray-01)]/60 px-3 py-2.5"
                  >
                    <span className="font-mono text-[12px] text-[var(--gray-12)]">{row.f}</span>
                    <span className="font-mono text-[12px]" style={{ color: ACCENT }}>
                      {row.l}
                    </span>
                    <span className="ml-auto font-mono text-[11px] text-[var(--gray-09)]">
                      {row.r}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </Reveal>

          {/* What lands in the console — verified observability */}
          <Reveal>
            <p className="mt-16 text-[15px] font-bold text-[var(--gray-12)]">
              So you always know what it cost — and whether to trust it.
            </p>
          </Reveal>
          <div className="mt-4 grid sm:grid-cols-2 sm:gap-x-14">
            {[
              { icon: <IconRuns />, title: "Replay any run", desc: "See exactly what an agent did, start to finish — no guessing what happened overnight." },
              { icon: <IconCost />, title: "Know the real dollars", desc: "What each run actually cost, across every repo and your whole team — so spend never surprises you." },
              { icon: <IconFail />, title: "See why it failed", desc: "When a run doesn't land, the root cause is right there, linked to the run that caused it." },
              { icon: <IconAudit />, title: "Promote a review to an issue", desc: "Reviews never block a merge — turn any finding into a tracked GitHub or Linear issue in a click." },
            ].map((c, i) => (
              <Reveal key={c.title} delay={(i % 2) * 60}>
                <div className="flex gap-4 border-b border-[var(--gray-04)] py-5">
                  <span className="mt-0.5 shrink-0 text-[var(--gray-08)]">{c.icon}</span>
                  <div>
                    <h3 className="text-[15px] font-bold text-[var(--gray-12)]">{c.title}</h3>
                    <p className="mt-1 text-[13px] leading-relaxed text-[var(--gray-10)]">
                      {c.desc}
                    </p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* CLI vs Console — why the dashboard */}
      <section className="relative z-10 border-t border-[var(--gray-04)]/60 px-6 py-20">
        <div className="mx-auto max-w-[1180px]">
          <Reveal>
            <h2
              className={`${display.className} max-w-[22ch] text-[clamp(1.7rem,3vw,2.5rem)] font-extrabold tracking-[-0.03em]`}
            >
              The CLI runs your agents. The console runs your team.
            </h2>
            <p className="mt-3 max-w-[56ch] text-[15px] leading-relaxed text-[var(--gray-10)]">
              The CLI is{" "}
              <span className="text-[var(--gray-12)]">free, forever</span>. The
              console is the team layer — one place to see, cost, and govern
              every run, across every repo.
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
                  <span className="rounded-full border border-[var(--gray-05)] px-2.5 py-0.5 text-[11px] text-[var(--gray-09)]">
                    Free · every developer
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
                <div className="relative flex items-center justify-between">
                  <span className="text-[15px] font-bold" style={{ color: ACCENT }}>
                    AgentRail Console
                  </span>
                  <span
                    className="rounded-full px-2.5 py-0.5 text-[11px] font-medium text-black"
                    style={{ background: ACCENT }}
                  >
                    Teams · see &amp; govern
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
                    "Connectors for GitHub, Linear & chat",
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

      {/* FAQ */}
      <section
        id="faq"
        className="relative z-10 border-t border-[var(--gray-04)]/60 px-6 py-20"
      >
        <div className="mx-auto max-w-[820px]">
          <Reveal>
            <h2
              className={`${display.className} text-[clamp(1.7rem,3vw,2.5rem)] font-extrabold tracking-[-0.03em]`}
            >
              Questions, answered.
            </h2>
          </Reveal>
          <Reveal
            delay={100}
            className="mt-10 divide-y divide-[var(--gray-04)] border-y border-[var(--gray-04)]"
          >
            {FAQS.map((f) => (
              <Faq key={f.q} q={f.q} a={f.a} />
            ))}
          </Reveal>
        </div>
      </section>

      {/* Final CTA */}
      <section className="relative z-10 border-t border-[var(--gray-04)]/60 px-6 py-24">
        <div className="mx-auto max-w-[1180px]">
          <Reveal className="relative overflow-hidden rounded-2xl border border-[var(--gray-05)] bg-[var(--gray-01)] px-8 py-16 text-center">
            <h2
              className={`${display.className} relative text-[clamp(1.9rem,3.6vw,2.9rem)] font-extrabold tracking-[-0.03em]`}
            >
              Clear your backlog overnight.
            </h2>
            <p className="relative mx-auto mt-4 max-w-[46ch] text-[15px] text-[var(--gray-10)]">
              Connect a repo, point it at an issue, and wake up to a reviewed PR —
              for a fraction of the tokens.
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
            <p className="relative mt-4 text-[12px] text-[var(--gray-09)]">
              Free while in preview
            </p>
          </Reveal>
        </div>
      </section>

      {/* Footer — structured, multi-column, editorial */}
      <footer className="relative z-10 border-t border-[var(--gray-04)] px-6 pb-10 pt-16">
        <div className="mx-auto grid max-w-[1180px] grid-cols-2 gap-10 md:grid-cols-[1.6fr_repeat(3,1fr)]">
          {/* Brand column */}
          <div className="col-span-2 max-w-[30ch] md:col-span-1">
            <div className="flex items-center gap-2.5">
              <RailMark />
              <span className={`${display.className} text-[15px] font-extrabold tracking-tight`}>
                AgentRail
              </span>
            </div>
            <p className="mt-3 text-[13px] leading-relaxed text-[var(--gray-10)]">
              The agent control plane for engineering teams — compiled context,
              enforced review gates, and real-dollar cost in one workspace.
            </p>
            <p className="mt-4 font-mono text-[11px] text-[var(--gray-09)]">
              repo-native · deterministic · inspectable
            </p>
          </div>

          {FOOTER_COLUMNS.map((col) => (
            <div key={col.title}>
              <h3 className="font-mono text-[11px] uppercase tracking-wider text-[var(--gray-09)]">
                {col.title}
              </h3>
              <ul className="mt-3 space-y-2">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      className="text-[13px] text-[var(--gray-10)] transition-colors hover:text-[var(--gray-12)]"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mx-auto mt-12 flex max-w-[1180px] flex-col items-start justify-between gap-3 border-t border-[var(--gray-04)] pt-6 sm:flex-row sm:items-center">
          <span className="text-[12px] text-[var(--gray-09)]">
            © {new Date().getFullYear()} AgentRail. All rights reserved.
          </span>
          <span className="font-mono text-[11px] text-[var(--gray-08)]">
            Built for teams that run agents at scale.
          </span>
        </div>
      </footer>
    </main>
  );
}

const FOOTER_COLUMNS: { title: string; links: { label: string; href: string }[] }[] = [
  {
    title: "Product",
    links: [
      { label: "How it works", href: "#how" },
      { label: "Benchmark", href: "#proof" },
      { label: "Platform", href: "#capabilities" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Documentation", href: "/docs" },
      { label: "GitHub", href: "https://github.com/Bensigo/agentrail" },
      { label: "CLI", href: "https://github.com/Bensigo/agentrail#cli" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "FAQ", href: "#faq" },
      { label: "Sign in", href: "/" },
    ],
  },
];

/* ---------------------------------------------------------------- pieces */

function Step({
  n,
  title,
  desc,
  cmd,
}: {
  n: string;
  title: string;
  desc: string;
  cmd: string;
}) {
  return (
    <div className="ar-cell flex h-full flex-col rounded-xl border border-[var(--gray-05)] bg-[var(--gray-01)]/60 p-5">
      <div className="flex items-baseline justify-between">
        <span
          className={`${display.className} text-[2.4rem] font-extrabold leading-none tracking-tight text-[var(--gray-06)]`}
        >
          {n}
        </span>
        <span className="rounded-full border border-[var(--gray-05)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[var(--gray-09)]">
          Step
        </span>
      </div>
      <h3 className="mt-4 text-[15px] font-bold text-[var(--gray-12)]">{title}</h3>
      <p className="mt-2 flex-1 text-[13px] leading-relaxed text-[var(--gray-10)]">
        {desc}
      </p>
      <code
        className="mt-4 inline-block self-start rounded-md border border-[var(--gray-05)] bg-[var(--gray-00)]/60 px-2.5 py-1.5 font-mono text-[12px]"
        style={{ color: ACCENT }}
      >
        {cmd}
      </code>
    </div>
  );
}

function Faq({ q, a }: { q: string; a: string }) {
  return (
    <details className="group py-4">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[15px] font-medium text-[var(--gray-12)] [&::-webkit-details-marker]:hidden">
        {q}
        <span
          aria-hidden
          className="shrink-0 text-lg leading-none transition-transform duration-200 group-open:rotate-45"
          style={{ color: ACCENT }}
        >
          +
        </span>
      </summary>
      <p className="mt-3 max-w-[68ch] text-[14px] leading-relaxed text-[var(--gray-10)]">
        {a}
      </p>
    </details>
  );
}

function TrackRecord({ data }: { data: typeof TRACK_RECORD }) {
  return (
    <div>
      <div className="grid items-center gap-10 lg:grid-cols-[1.05fr_1fr] lg:gap-16">
        {/* the headline: real PRs shipped */}
        <div>
          <span
            className={`${display.className} block text-[clamp(3.6rem,9vw,6.5rem)] font-extrabold leading-[0.88] tracking-[-0.04em]`}
            style={{ color: ACCENT }}
          >
            <CountUp to={data.shipped} />
          </span>
          <p className="mt-4 max-w-[30ch] text-[15px] leading-relaxed text-[var(--gray-10)]">
            of its own issues taken from open to a{" "}
            <span className="text-[var(--gray-12)]">reviewed PR</span> —
            unattended.
          </p>
        </div>

        {/* one real run, plus the honest miss count */}
        <div className="space-y-5">
          <div className="rounded-xl border border-[var(--gray-05)] bg-[var(--gray-01)]/60 p-5">
            <p className="text-[12px] text-[var(--gray-09)]">One run, start to finish</p>
            <p className="mt-1.5 text-[14px] font-medium text-[var(--gray-12)]">
              #{data.sample.issue} &ldquo;{data.sample.title}&rdquo;{" "}
              <span className="text-[var(--gray-09)]">→</span>{" "}
              <span className="font-mono" style={{ color: ACCENT }}>
                PR #{data.sample.pr}
              </span>
            </p>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--gray-10)]">
              First attempt · one review round · no errors.
            </p>
          </div>
          <p className="text-[13px] leading-relaxed text-[var(--gray-09)]">
            <span className="text-[var(--gray-11)]">
              {data.failed} of {data.attempted} didn&apos;t land
            </span>{" "}
            — they hit a gate or review and stopped to a human. We count the
            misses too; no cherry-picking.
          </p>
        </div>
      </div>

      <p className="mt-10 max-w-[74ch] text-[13px] leading-relaxed text-[var(--gray-09)]">
        Real autonomous runs on AgentRail&apos;s own backlog
        (<span className="font-mono text-[12px]">Bensigo/agentrail</span>) — full
        runs, not a synthetic or retrieval benchmark. One project; directional,
        and honest about it.
      </p>
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
function IconCost() {
  return <svg {...ic}><path d="M12 2v20" /><path d="M17 6.5C17 4.5 14.8 4 12 4S7 4.8 7 7s2.5 2.7 5 3 5 1 5 3.2-2.2 2.8-5 2.8-5-.7-5-2.8" /></svg>;
}
function IconFail() {
  return <svg {...ic}><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg>;
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

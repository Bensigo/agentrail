import { auth, signIn } from "@agentrail/auth";
import { listWorkspacesForUser, claimInvitesForUser } from "@agentrail/db-postgres";
import { redirect } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { Send } from "lucide-react";
import { LIGHT_SURFACE } from "../../lib/light-surface";
import { Reveal } from "./_motion";
import { MarketingNav } from "./_nav";
import { PhoneDemo } from "./_phone-demo";
import { UseCases } from "./_use-cases";
import { Channels } from "./_channels";
import { CountUp } from "./_stats";
import { getLandingStats } from "../../lib/landing-stats";
import { resolveMessageJaceCta } from "./_cta";
import type { MessageJaceCta } from "./_cta";
import { resolveDiscordChannelCard, resolveSlackChannelCard } from "./_channel-cards";


/**
 * How we work together — the real loop, in order (controller ruling, #1279
 * PR ②: "issue→brief→approve→PR→you merge; merge-permission opt-in is now
 * TRUE and worth saying"), now as landing v2's NAMED steps. Merge permission
 * is a real, live, owner-only toggle (Settings → Permissions), off by
 * default — so "you merge" stays the honest default step, and the Merge
 * step states the opt-in without overclaiming it as automatic. See
 * apps/console/app/api/v1/runner/result/route.ts for the actual enforcement
 * this line describes.
 */
const HOW_WE_WORK = [
  { name: "Message", line: "Send me a task in chat, or hand me a GitHub issue." },
  {
    name: "Brief",
    line: "Before I touch code you get a brief: task type, model, and a dollar estimate.",
  },
  { name: "Approve", line: "Your approval sets the run's budget. That number is the cap." },
  {
    name: "Pull request",
    line: "I write the code, a second model reviews it, and your own tests have to pass. Then the PR opens.",
  },
  {
    name: "Merge",
    line: "You merge it. Or turn on merge permission in Settings and I'll merge once the gate is green.",
  },
];

/**
 * The secondary sign-in path (controller ruling, #1279 PR ①: "GitHub sign-in
 * demoted to nav + footer secondary"). Also the honest fallback for the
 * primary CTA itself when no hosted Telegram bot is configured — see
 * {@link PrimaryCta}. One named server action, referenced from every call
 * site, rather than four separate inline closures.
 */
async function signInWithGithub() {
  "use server";
  await signIn("github", { redirectTo: "/" });
}

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

  // Telegram is the only open chat door today (#1262/#1263 shipped). A
  // multi-channel picker (Discord/Slack/iMessage) arrives with W5 — see
  // docs/superpowers/plans/2026-07-17-jace-e2e-arc-issues.md. Until then this
  // resolves one plain path, no picker component: Message Jace on Telegram
  // when the hosted bot is configured, else the honest sign-in fallback
  // (never a dead link) — see `./_cta.ts`.
  const cta = resolveMessageJaceCta(process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME);

  // Landing v2 §6 — live numbers: documented dogfood baseline + platform
  // terminal outcomes, hourly-cached; baseline-only when the DB is away.
  const stats = await getLandingStats();

  // #1284 AC2 (landing-honesty rule): resolves to null — rendering nothing
  // extra — until BOTH a Discord invite URL is configured AND the channel is
  // explicitly flagged live post-prod-verification. See `./_channel-cards.ts`.
  const discordCard = resolveDiscordChannelCard({
    live: process.env.NEXT_PUBLIC_DISCORD_CHANNEL_LIVE,
    inviteUrl: process.env.NEXT_PUBLIC_DISCORD_INVITE_URL,
  });
  // #1285 AC2 (landing-honesty rule): resolves to null — rendering nothing
  // extra — until BOTH a Slack install URL is configured AND the channel is
  // explicitly flagged live post-prod-verification. See `./_channel-cards.ts`.
  const slackCard = resolveSlackChannelCard({
    live: process.env.NEXT_PUBLIC_SLACK_CHANNEL_LIVE,
    installUrl: process.env.NEXT_PUBLIC_SLACK_INSTALL_URL,
  });

  return (
    <main
      id="top"
      style={LIGHT_SURFACE}
      className="relative min-h-screen bg-[var(--paper)] text-[var(--gray-12)]"
    >
      {/* 1 — Nav: plain wordmark + Sign in at the top; condenses into a
          floating pill with the primary Message-Jace CTA once the visitor
          scrolls into the story. See _nav.tsx. */}
      <MarketingNav cta={cta} signInAction={signInWithGithub} />

      {/* 2 — Hero: the centered stage (owner-chosen 2026-07-22, boardy's
          formula) — avatar disc, display headline, role line, ONE button.
          Nothing competes; the phone gets its own act below. */}
      <section className="px-6 pt-24 pb-16 text-center sm:pt-32 sm:pb-20">
        <div className="mx-auto flex max-w-[720px] flex-col items-center">
          <Image
            src="/jace-avatar.png"
            alt=""
            width={88}
            height={88}
            priority
            className="ar-rise rounded-full"
          />
          <h1 className="ar-rise mt-8" style={{ animationDelay: "60ms" }}>
            <span className="text-heading-1 block">Hey, I&apos;m Jace</span>
            <span className="text-heading-2 mt-5 block text-balance">
              The AI{" "}
              <span className="rounded-sm bg-[var(--accent-fill)] px-1.5 text-[var(--accent-fill-text)]">
                fractional
              </span>{" "}
              software engineer.
            </span>
          </h1>
          <div className="ar-rise mt-10" style={{ animationDelay: "150ms" }}>
            <PrimaryCta cta={cta} />
          </div>
        </div>
      </section>

      {/* 2b — The conversation act: device-as-stage at full width (the
          phone moved out of the hero, owner-chosen 2026-07-22). Its typing
          choreography arms when it scrolls into view. */}
      <section className="px-6 pb-20 sm:pb-24">
        <div className="mx-auto flex max-w-[720px] flex-col items-center gap-4">
          <Reveal>
            <PhoneDemo />
          </Reveal>
          <Reveal delay={80}>
            <p className="text-body-sm max-w-[38ch] text-center text-[var(--gray-11)]">
              The brief in this demo is computed by the same code that prices
              real runs.
            </p>
          </Reveal>
        </div>
      </section>

      {/* 3 — Use cases: sticky cards that deck over each other as the
          visitor scrolls (landing v2 §3, heading per owner 2026-07-22).
          Every card maps to a real product surface — see _use-cases.tsx. */}
      <section className="px-6 pb-24 sm:pb-32">
        <div className="mx-auto max-w-[860px]">
          <Reveal>
            <h2 className="text-heading-2 text-center">Use cases</h2>
          </Reveal>
        </div>
        <div className="mt-12">
          <UseCases />
        </div>
      </section>

      {/* 5 — ACT 2: how I work, as one loud full-bleed lemon scene — the
          page's one moment of scale, restyled per owner feedback 2026-07-22
          ("boring") into an editorial rail: five columns under ink top-bars,
          numerals at poster size. Content is the exact same 5-step loop;
          see HOW_WE_WORK's own comment above for why the Merge step phrases
          merge permission as an opt-in rather than the default. */}
      {/* The lemon band is the stack's NEXT CARD (owner feedback 2026-07-22:
          sections must blend, one fabric): it slides OVER the pinned
          use-case cards — rounded top, ink edge, later in flow so it paints
          above the sticky deck. The whole page reads as sheets riding over
          sheets from here on. */}
      <section className="relative -mt-16 w-full rounded-t-[2.5rem] border-t-2 border-[var(--gray-13)] bg-[var(--accent-fill)] px-6 py-24 sm:py-32">
        <div className="mx-auto max-w-[1120px]">
          <Reveal>
            <h2 className="text-heading-2 text-[var(--accent-fill-text)]">
              How I work
            </h2>
          </Reveal>
          {/* Comic-panel bento (owner personality pass 2026-07-22 — "make
              use of grid"): paper panels with ink borders and hard offset
              shadows on the lemon, 2-2-2 / 3-3 spans. All panel text uses
              --accent-fill-text — the scene's ink token. */}
          <ol className="mt-14 grid grid-cols-1 gap-6 sm:mt-20 sm:grid-cols-2 lg:grid-cols-6">
            {HOW_WE_WORK.map((step, i) => (
              <Reveal
                key={step.name}
                delay={i * 70}
                className={i < 3 ? "lg:col-span-2" : "lg:col-span-3"}
              >
                {/* No decorative numerals (owner ruling 2026-07-22 — they
                    read as slop-catalog LS-5): the serif step NAME is the
                    panel's anchor; the grid order carries the sequence. */}
                <li className="flex h-full flex-col rounded-xl border-2 border-[var(--accent-fill-text)] bg-[var(--paper)] p-6 shadow-[5px_5px_0_0_var(--accent-fill-text)] sm:p-8">
                  <h3 className="text-heading-2 text-[var(--accent-fill-text)]">
                    {step.name}
                  </h3>
                  <p className="mt-3 leading-relaxed text-[var(--accent-fill-text)]">
                    {step.line}
                  </p>
                </li>
              </Reveal>
            ))}
          </ol>
        </div>
      </section>

      {/* 5b — Where you'll find me: the channel scene. Panels present all
          three channels per the owner's 2026-07-22 ruling; every button
          resolves through the honesty-gated URL resolvers and falls back to
          sign-in — never a dead link. See _channels.tsx. */}
      {/* The paper sheet rides over the lemon in turn — same sheet-over-
          sheet seam, so the acts hand off instead of hard-cutting. */}
      <section className="relative -mt-14 rounded-t-[2.5rem] border-t-2 border-[var(--gray-13)] bg-[var(--paper)] px-6 pt-20 pb-24 sm:pt-24 sm:pb-28">
        <div className="mx-auto max-w-[1120px]">
          <Reveal>
            <h2 className="text-heading-2 text-center">Where you&apos;ll find me</h2>
          </Reveal>
          <Reveal delay={70}>
            <p className="mx-auto mt-4 max-w-[44ch] text-center text-[var(--gray-11)]">
              Add me where your team already talks.
            </p>
          </Reveal>
          <div className="mt-12">
            <Channels
              cta={cta}
              slack={slackCard}
              discord={discordCard}
              signInAction={signInWithGithub}
            />
          </div>
        </div>
      </section>

      {/* 6 — The numbers: live stats (baseline + platform outcomes) as
          tilted paper scraps, count-up on scroll. The failed card is
          deliberately DIFFERENT (wider, untilted, sentence label) — the
          slop audit's LS-1/LS-2 fix: honest numbers shouldn't wear the
          identical-stat-grid costume. Labels sit at --gray-11 (GQ-1). */}
      <section className="px-6 py-24 sm:py-32">
        <div className="mx-auto max-w-[760px]">
          <Reveal>
            <h2 className="text-heading-2 text-center">The numbers</h2>
          </Reveal>
          <p className="ar-rise mx-auto mt-4 max-w-[56ch] text-center text-[var(--gray-11)]">
            Autonomous runs, issue in to reviewed pull request out. Counted
            from the platform database, refreshed hourly.
          </p>
          <div className="mt-14 flex flex-wrap items-start justify-center gap-6 sm:gap-8">
            {/* Cards stay inlined: the mono-on-data craft pin scans 300
                chars BACKWARD from each literal {stats.x} marker for a mono
                class, so the class must sit in the same JSX block. */}
            <Reveal>
              <div className="w-[168px] -rotate-2 rounded-lg border-2 border-[var(--gray-13)] bg-[var(--paper)] px-5 py-6 text-center shadow-[4px_4px_0_0_var(--gray-13)] sm:w-[188px]">
                <CountUp
                  className="text-4xl font-mono font-bold text-[var(--gray-12)] sm:text-5xl"
                  value={stats.shipped}
                />
                <p className="text-body-sm mt-2 text-[var(--gray-11)]">shipped</p>
              </div>
            </Reveal>
            <Reveal delay={70}>
              <div className="w-[168px] translate-y-3 rotate-1 rounded-lg border-2 border-[var(--gray-13)] bg-[var(--paper)] px-5 py-6 text-center shadow-[4px_4px_0_0_var(--gray-13)] sm:w-[188px]">
                <CountUp
                  className="text-4xl font-mono font-bold text-[var(--gray-12)] sm:text-5xl"
                  value={stats.workedOn}
                />
                <p className="text-body-sm mt-2 text-[var(--gray-11)]">worked on</p>
              </div>
            </Reveal>
            <Reveal delay={140}>
              <div className="w-[240px] rounded-lg border-2 border-[var(--gray-13)] bg-[var(--paper)] px-6 py-6 text-center shadow-[4px_4px_0_0_var(--gray-13)] sm:w-[260px]">
                <CountUp
                  className="text-4xl font-mono font-bold text-[var(--gray-12)] sm:text-5xl"
                  value={stats.didntLand}
                />
                <p className="mt-2 text-[var(--gray-11)]">
                  didn&apos;t land — counted, not hidden
                </p>
              </div>
            </Reveal>
          </div>
          {stats.source === "baseline-only" ? (
            <p className="text-body-sm mt-8 text-center text-[var(--gray-11)]">
              Live counts unavailable right now; these are the documented
              dogfood record.
            </p>
          ) : null}
        </div>
      </section>

      {/* 6b — Billing: the pay-for-what-you-use top-up model (owner ruling
          2026-07-22). States the future model in plain steps while the
          free-preview chip carries today's truth. */}
      <section className="px-6 pb-24 sm:pb-32">
        <div className="mx-auto max-w-[560px]">
          <Reveal>
            <h2 className="text-heading-2 text-center">Pay for what you use</h2>
          </Reveal>
          <Reveal delay={70}>
            <p className="mx-auto mt-4 max-w-[44ch] text-center text-[var(--gray-11)]">
              Pricing is pay-for-what-you-use.
            </p>
          </Reveal>
          <ol className="mt-10 flex flex-col gap-6">
            {[
              "Top up your balance.",
              "Approve a task. The estimate you approve is the budget cap.",
              "You're charged when the task is done.",
            ].map((line, i) => (
              <Reveal key={i} delay={i * 70}>
                <li className="flex items-baseline gap-4">
                  <span
                    aria-hidden
                    className="h-2.5 w-2.5 shrink-0 rounded-sm border border-[var(--gray-13)] bg-[var(--accent-fill)]"
                  />
                  <p className="text-[var(--gray-12)]">{line}</p>
                </li>
              </Reveal>
            ))}
          </ol>
          <Reveal delay={240}>
            <div className="mt-10 flex flex-col items-center gap-4 text-center">
              <p className="text-[var(--gray-11)]">
                No seats. No subscription. Every run shows its cost next to
                its PR.
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* 7 — Closing CTA + minimal footer. Mascot appearance 2 of 2 — Jace
          beside his own ask, angled toward the button below. */}
      <section className="px-6 pb-24 text-center">
        <Reveal className="mx-auto max-w-[620px]">
          {/* The wave render's home (moved out of the hero, owner feedback
              2026-07-22) — Jace waving beside his own closing ask. */}
          <Image
            src="/jace-wave.png"
            alt="Jace"
            width={180}
            height={180}
            className="-rotate-3 mx-auto mb-6"
          />
          <h2 className="text-heading-2">
            Point me at a repo
            <span aria-hidden className="ar-cursor animate-pulse font-mono">
              _
            </span>
          </h2>
          <p className="mx-auto mt-4 max-w-[44ch] text-[var(--gray-11)]">
            Connect GitHub, hand me an issue, and wake up to a reviewed PR.
          </p>
          <div className="mt-8 flex flex-col items-center gap-3">
            <PrimaryCta cta={cta} />
          </div>
        </Reveal>
      </section>

      <footer className="border-t border-[var(--gray-04)] px-6 py-10">
        <div className="mx-auto flex max-w-[1120px] flex-col items-center justify-between gap-4 sm:flex-row">
          <div className="flex items-center gap-2.5">
            <Image
              src="/jace-avatar.png"
              alt=""
              width={20}
              height={20}
              className="rounded-full"
            />
            <span className="font-bold tracking-tight">Jace</span>
          </div>
          <nav className="text-body-sm flex items-center gap-6 text-[var(--gray-11)]">
            <Link href="/docs" className="rounded-sm transition-colors hover:text-[var(--accent-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gray-13)]">
              Docs
            </Link>
            <a
              href="https://github.com/Bensigo/agentrail"
              className="rounded-sm transition-colors hover:text-[var(--accent-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gray-13)]"
            >
              GitHub
            </a>
            <a
              href="https://github.com/Bensigo/agentrail#cli"
              className="rounded-sm transition-colors hover:text-[var(--accent-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gray-13)]"
            >
              CLI
            </a>
            {/* #1284 AC2: only renders once Discord is both configured AND
                flagged live post-prod-verification — see _channel-cards.ts. */}
            {discordCard ? (
              <a
                href={discordCard.href}
                target="_blank"
                rel="noreferrer"
                className="rounded-sm transition-colors hover:text-[var(--accent-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gray-13)]"
              >
                Discord
              </a>
            ) : null}
            {/* #1285 AC2: only renders once Slack is both configured AND
                flagged live post-prod-verification — see _channel-cards.ts. */}
            {slackCard ? (
              <a
                href={slackCard.href}
                target="_blank"
                rel="noreferrer"
                className="rounded-sm transition-colors hover:text-[var(--accent-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gray-13)]"
              >
                Slack
              </a>
            ) : null}
            <form action={signInWithGithub}>
              <button
                type="submit"
                className="text-body-sm rounded-sm text-[var(--gray-11)] transition-colors hover:text-[var(--accent-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gray-13)]"
              >
                Sign in
              </button>
            </form>
          </nav>
          <span className="text-label text-[var(--gray-11)]">
            © {new Date().getFullYear()} AgentRail
          </span>
        </div>
      </footer>
    </main>
  );
}

/* ------------------------------------------------------------------ CTA */

/**
 * The hero + closing primary CTA (controller ruling, #1279 PR ①: "REPLACE").
 * Message Jace on Telegram when the hosted bot is configured; otherwise the
 * honest sign-in fallback — same visual weight either way, never a dead
 * link. See `./_cta.ts` for the resolution logic and its drift-guard tests.
 */
/** The cartoon-ink press recipe (owner personality pass 2026-07-22): ink
 *  border + hard offset shadow; hover nudges into the shadow, active lands
 *  flat — a button that feels drawn, then pressed. */
const INK_BUTTON =
  "inline-flex items-center gap-2.5 rounded-md border-2 border-[var(--gray-13)] bg-[var(--accent-fill)] px-7 py-3.5 font-bold text-[var(--accent-fill-text)] shadow-[4px_4px_0_0_var(--gray-13)] transition-[transform,background-color,box-shadow] duration-150 ease-out hover:translate-x-[2px] hover:translate-y-[2px] hover:bg-[var(--accent-fill-hover)] hover:shadow-[2px_2px_0_0_var(--gray-13)] active:translate-x-[4px] active:translate-y-[4px] active:shadow-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gray-13)]";

function PrimaryCta({ cta }: { cta: MessageJaceCta }) {
  if (cta.kind === "telegram") {
    return (
      <a href={cta.href} target="_blank" rel="noreferrer" className={INK_BUTTON}>
        <Send size={17} aria-hidden />
        Message Jace on Telegram
      </a>
    );
  }
  // No hosted bot configured: the button still reads as Jace's own ask
  // (owner directive 2026-07-22 — "this should be a message me button");
  // sign-in IS the door to messaging him when no public bot exists, and
  // the action stays the same honest server action either way.
  return (
    <form action={signInWithGithub}>
      <button type="submit" className={INK_BUTTON}>
        <Send size={17} aria-hidden />
        Message Jace
      </button>
    </form>
  );
}



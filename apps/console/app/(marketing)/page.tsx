import { auth, signIn } from "@agentrail/auth";
import { listWorkspacesForUser, claimInvitesForUser } from "@agentrail/db-postgres";
import { redirect } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import type { CSSProperties } from "react";
import { Send } from "lucide-react";
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


/** Light token surface scoped to the marketing page.
 *
 *  The app shell (app/layout.tsx) now defaults `<html>` to light, but the
 *  dashboard's theme toggle persists a "dark" preference to localStorage for
 *  the whole app (one shared `<html>` element, see app/layout.tsx's inline
 *  script). A visitor who toggled dark in the console and later lands back on
 *  "/" would otherwise see a dark landing page. TASTE.md mandates the landing
 *  always reads light — it's Jace's resume, not a themeable console surface —
 *  so we re-establish the documented `:root` token values on this subtree
 *  regardless of the toggle. These are the exact light values from
 *  globals.css, not new colors. Everything below (including <ConversationDemo/>)
 *  inherits them via the CSS custom-property cascade. */
const LIGHT_SURFACE: CSSProperties = {
  colorScheme: "light",
  ["--gray-00" as string]: "#ffffff",
  ["--gray-01" as string]: "#fcfcfc",
  ["--gray-02" as string]: "#f9f9f9",
  ["--gray-03" as string]: "#f0f0f0",
  ["--gray-04" as string]: "#e8e8e8",
  ["--gray-05" as string]: "#e0e0e0",
  ["--gray-06" as string]: "#d9d9d9",
  ["--gray-07" as string]: "#cecece",
  ["--gray-08" as string]: "#bbbbbb",
  ["--gray-09" as string]: "#8d8d8d",
  ["--gray-10" as string]: "#838383",
  ["--gray-11" as string]: "#646464",
  ["--gray-12" as string]: "#202020",
  ["--gray-13" as string]: "#0c0c0c",
  ["--blue-11" as string]: "#0d74ce",
  ["--green-11" as string]: "#208368",
  ["--red-11" as string]: "#ce2c31",
  ["--orange-11" as string]: "#cc4e00",
  ["--yellow-11" as string]: "#9e6c00",
  ["--purple-11" as string]: "#6550b9",
  ["--teal-11" as string]: "#008573",
  ["--brand-accent" as string]: "#ffe629",
  ["--accent-text" as string]: "#0c0c0c",
  ["--accent-fill" as string]: "#ffe629",
  ["--accent-fill-text" as string]: "#0c0c0c",
  ["--accent-fill-hover" as string]: "#ffdc00",
  ["--paper" as string]: "#fffbea",
} as CSSProperties;

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
  { name: "Pull request", line: "I write the code and open a PR against your repo." },
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

      {/* 2 — Hero: two columns on desktop (intro left, live phone demo
          right), stacked and centered below lg. The display line carries the
          serif at full scale; the role line drops one step (slop-audit TY-6:
          no long sentence at 72px). The mascot IS Jace (TASTE.md canon) —
          the owner-supplied wave render opens his page. */}
      <section className="px-6 pt-14 pb-20 sm:pt-16 sm:pb-24">
        <div className="mx-auto flex max-w-[1120px] flex-col items-center gap-12 text-center lg:grid lg:grid-cols-[1.1fr_auto] lg:items-center lg:gap-16 lg:text-left">
          <div className="flex flex-col items-center lg:items-start">
            {/* mix-blend-multiply drops the render's white matte into the
                paper surface — a cutout, not a white box. */}
            <Image
              src="/jace-wave.png"
              alt="Jace"
              width={140}
              height={140}
              priority
              className="ar-rise mb-6 mix-blend-multiply"
            />

            <h1 className="ar-rise" style={{ animationDelay: "60ms" }}>
              <span className="text-heading-1 block">
                Hey, I&apos;m Jace
                <span aria-hidden className="ar-cursor animate-pulse font-mono">
                  _
                </span>
              </span>
              <span className="text-heading-2 mt-3 block text-balance">
                Your{" "}
                <span className="rounded-sm bg-[var(--accent-fill)] px-1.5 text-[var(--accent-fill-text)]">
                  fractional
                </span>{" "}
                AI software engineer.
              </span>
            </h1>

            <p
              className="ar-rise mt-6 max-w-[52ch] text-[var(--gray-11)]"
              style={{ animationDelay: "120ms" }}
            >
              I take the issues you never get to. I triage them, write the
              code, and open a pull request. Nothing merges without you.
            </p>

            <div
              className="ar-rise mt-9 flex flex-col items-center gap-3 lg:items-start"
              style={{ animationDelay: "190ms" }}
            >
              <PrimaryCta cta={cta} />
              <FreePreviewChip />
            </div>
          </div>

          <div
            className="ar-rise flex flex-col items-center gap-3"
            style={{ animationDelay: "240ms" }}
          >
            <PhoneDemo />
            <p className="text-body-sm max-w-[38ch] text-center text-[var(--gray-11)]">
              The brief in this demo is computed by the same code that prices
              real runs.
            </p>
          </div>
        </div>
      </section>

      {/* 3 — Use cases: four sticky cards that deck over each other as the
          visitor scrolls (landing v2 §3). Copy absorbs the old What-I-do
          claims; card 2's chip is the same task the hero phone prices. */}
      <section className="px-6 pb-24 sm:pb-32">
        <div className="mx-auto max-w-[860px]">
          <Reveal>
            <h2 className="text-heading-2 text-center">What you can hand me</h2>
          </Reveal>
        </div>
        <div className="mt-12">
          <UseCases />
        </div>
      </section>

      {/* 5 — ACT 2: how we work together, as one loud full-bleed lemon
          scene — the page's one moment of scale. Content is the exact same
          5-step loop as before; see HOW_WE_WORK's own comment above for why
          step 5 phrases merge permission as an opt-in rather than the
          default. */}
      <section className="w-full bg-[var(--accent-fill)] px-6 py-24 sm:py-32">
        <div className="mx-auto max-w-[760px]">
          <Reveal>
            <h2 className="text-heading-2 text-[var(--accent-fill-text)]">
              How we work together
            </h2>
          </Reveal>
          <ol className="mt-14 flex flex-col gap-10 sm:mt-20 sm:gap-14">
            {HOW_WE_WORK.map((step, i) => (
              <Reveal key={step.name} delay={i * 70}>
                <li className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:gap-8">
                  <span
                    aria-hidden
                    className="text-5xl leading-none font-mono font-bold text-[var(--accent-fill-text)] sm:w-16 sm:shrink-0 sm:text-6xl"
                  >
                    {i + 1}
                  </span>
                  <div>
                    <p className="font-bold text-[var(--accent-fill-text)]">{step.name}</p>
                    <p className="mt-1 text-lg leading-relaxed text-[var(--accent-fill-text)] sm:text-xl">
                      {step.line}
                    </p>
                  </div>
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
      <section className="px-6 py-24 sm:py-28">
        <div className="mx-auto max-w-[960px]">
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
              <div className="w-[168px] -rotate-2 rounded-lg border border-[var(--gray-06)] bg-[var(--paper)] px-5 py-6 text-center shadow-sm sm:w-[188px]">
                <CountUp
                  className="text-4xl font-mono font-bold text-[var(--gray-12)] sm:text-5xl"
                  value={stats.shipped}
                />
                <p className="text-body-sm mt-2 text-[var(--gray-11)]">shipped</p>
              </div>
            </Reveal>
            <Reveal delay={70}>
              <div className="w-[168px] translate-y-3 rotate-1 rounded-lg border border-[var(--gray-06)] bg-[var(--paper)] px-5 py-6 text-center shadow-sm sm:w-[188px]">
                <CountUp
                  className="text-4xl font-mono font-bold text-[var(--gray-12)] sm:text-5xl"
                  value={stats.workedOn}
                />
                <p className="text-body-sm mt-2 text-[var(--gray-11)]">worked on</p>
              </div>
            </Reveal>
            <Reveal delay={140}>
              <div className="w-[240px] rounded-lg border border-[var(--gray-06)] bg-[var(--gray-00)] px-6 py-6 text-center shadow-sm sm:w-[260px]">
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
              When preview ends, pricing is pay-for-what-you-use.
            </p>
          </Reveal>
          <ol className="mt-10 flex flex-col gap-6">
            {[
              "Top up your balance.",
              "Approve a task. The estimate you approve is the budget cap.",
              "You're charged when the task is done.",
            ].map((line, i) => (
              <Reveal key={i} delay={i * 70}>
                <li className="flex items-baseline gap-5">
                  <span
                    aria-hidden
                    className="text-mono-data w-5 shrink-0 font-mono font-bold text-[var(--gray-12)]"
                  >
                    {i + 1}
                  </span>
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
              <FreePreviewChip />
            </div>
          </Reveal>
        </div>
      </section>

      {/* 7 — Closing CTA + minimal footer. Mascot appearance 2 of 2 — Jace
          beside his own ask, angled toward the button below. */}
      <section className="px-6 pb-24 text-center">
        <Reveal className="mx-auto max-w-[620px]">
          <Image
            src="/jace.png"
            alt=""
            width={64}
            height={64}
            className="-rotate-3 mx-auto mb-6 rounded-full"
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
            <FreePreviewChip />
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
            <Link href="/docs" className="transition-colors hover:text-[var(--accent-text)]">
              Docs
            </Link>
            <a
              href="https://github.com/Bensigo/agentrail"
              className="transition-colors hover:text-[var(--accent-text)]"
            >
              GitHub
            </a>
            <a
              href="https://github.com/Bensigo/agentrail#cli"
              className="transition-colors hover:text-[var(--accent-text)]"
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
                className="transition-colors hover:text-[var(--accent-text)]"
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
                className="transition-colors hover:text-[var(--accent-text)]"
              >
                Slack
              </a>
            ) : null}
            <form action={signInWithGithub}>
              <button
                type="submit"
                className="text-body-sm text-[var(--gray-11)] transition-colors hover:text-[var(--accent-text)]"
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
function PrimaryCta({ cta }: { cta: MessageJaceCta }) {
  if (cta.kind === "telegram") {
    return (
      <a
        href={cta.href}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-2.5 rounded-md bg-[var(--accent-fill)] px-7 py-3.5 font-bold text-[var(--accent-fill-text)] transition-[transform,background-color] duration-200 hover:-translate-y-0.5 hover:bg-[var(--accent-fill-hover)] active:scale-[0.97]"
      >
        <Send size={17} aria-hidden />
        Message Jace on Telegram
      </a>
    );
  }
  return (
    <form action={signInWithGithub}>
      <button
        type="submit"
        className="inline-flex items-center gap-2.5 rounded-md bg-[var(--accent-fill)] px-7 py-3.5 font-bold text-[var(--accent-fill-text)] transition-[transform,background-color] duration-200 hover:-translate-y-0.5 hover:bg-[var(--accent-fill-hover)] active:scale-[0.97]"
      >
        <GitHubIcon />
        Sign in with GitHub
      </button>
    </form>
  );
}

/** The "Free while in preview" highlight — a golden-fill chip (the
 *  fill-with-dark-text rule, on the owner-directed #1357 accent family),
 *  not a plain caption. Shared by the hero and closing CTA rows so both
 *  stay byte-identical. */
function FreePreviewChip() {
  return (
    <span className="text-label inline-flex items-center rounded-full bg-[var(--accent-fill)] px-3 py-1 text-[var(--accent-fill-text)]">
      Free while in preview
    </span>
  );
}

/* ---------------------------------------------------------------- icons */

function GitHubIcon() {
  return (
    <svg height="18" width="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

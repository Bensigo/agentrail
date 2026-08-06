import { auth, signIn } from "@agentrail/auth";
import { listWorkspacesForUser, claimInvitesForUser } from "@agentrail/db-postgres";
import { redirect } from "next/navigation";
import { claimSeatsForAcceptedInvites } from "../../lib/claim-invite-seats";
import Link from "next/link";
import Image from "next/image";
import { Send } from "lucide-react";
import { LIGHT_SURFACE } from "../../lib/light-surface";
import { Reveal } from "./_motion";
import { MarketingNav } from "./_nav";
import { PhoneDemo } from "./_phone-demo";
import { UseCases } from "./_use-cases";
import { Channels } from "./_channels";
import { resolveMessageJaceCta } from "./_cta";
import type { MessageJaceCta } from "./_cta";
import { resolveDiscordChannelCard, resolveSlackChannelCard } from "./_channel-cards";
// Shared tier card grid (subscription-platform slice 10, Task 1 — owner
// feedback 2026-08-02: the landing must show the FULL pricing cards, the
// same presentation /pricing renders, not slice 9's compact one-line tier
// summaries). Same TierCards component /pricing renders — see
// ./pricing/tier-cards.tsx's own doc-comment for why the grid lives in its
// own module rather than on either page.tsx file.
import { TierCards } from "./pricing/tier-cards";


/**
 * How Jace owns the acceptance spine while the selected external builder
 * writes code. The existing six-panel section stays intact; only its product
 * language changes with the trust-layer pivot.
 * PR ②: "issue→brief→approve→PR→you merge; merge-permission opt-in is now
 * TRUE and worth saying"), now as landing v2's NAMED steps. Merge permission
 * is a real, live, owner-only toggle (Settings → Permissions), off by
 * default — so "you merge" stays the honest default step, and the Merge
 * step states the opt-in without overclaiming it as automatic. See
 * apps/console/app/api/v1/runner/result/route.ts for the actual enforcement
 * this line describes.
 */
const HOW_WE_WORK = [
  {
    name: "Intake",
    line: "Your team keeps its own coding agent and normal environment. Turn a request into clear scope, acceptance criteria, and planned checks.",
  },
  {
    name: "Confirm",
    line: "Set the bar first: a human confirms the Acceptance Contract before implementation and review.",
  },
  {
    name: "Context",
    line: "Jace gives the selected coding agent a bounded Context Pack with the relevant code, decisions, tests, and exclusions.",
  },
  {
    name: "Build",
    line: "Your selected coding agent works in that environment. Jace does not write code or silently edit it.",
  },
  {
    name: "Review",
    line: "See what changed and the evidence attached to the exact revision against the confirmed contract.",
  },
  {
    name: "Decide",
    line: "Decide confidently with criterion-specific proof, a correction path, or an explicit not-proven result.",
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
        const claimedWorkspaceIds = await claimInvitesForUser({
          userId: session.user.id,
          email,
        });
        // Seat claim (spec §5 rule 1, slice 4 Task 3) — this landing-page
        // auto-claim-on-visit is the SECOND real entry point for the same
        // claimInvitesForUser call the /invite/[token] page uses (see
        // ../../lib/claim-invite-seats.ts's own doc-comment), so it gets the
        // identical hook. The helper never throws by contract, so it's safe
        // inside this same try even though the catch below exists for
        // claimInvitesForUser itself.
        await claimSeatsForAcceptedInvites(claimedWorkspaceIds, session.user.id);
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
            <span className="text-heading-1 block">Approve agent work with confidence.</span>
          </h1>
          <p className="ar-rise mt-6 max-w-[58ch] text-[var(--gray-11)]" style={{ animationDelay: "110ms" }}>
            Jace gives engineering teams the evidence and control they need to trust AI coding agents.
          </p>
          <div className="ar-rise mt-10" style={{ animationDelay: "150ms" }}>
            <PrimaryCta cta={cta} />
          </div>
        </div>
      </section>

      {/* The bottleneck section stays explicit: the note says attribution
          is unavailable in the current source set, so the page does not
          invent one. */}
      <section className="px-6 pb-14 sm:pb-18">
        <div className="mx-auto max-w-[720px]">
          <Reveal>
            <h2 className="text-heading-2 text-center">The bottleneck moved</h2>
          </Reveal>
          <Reveal delay={70}>
            <p className="mx-auto mt-4 max-w-[42ch] text-center text-[var(--gray-11)]">
              Attribution unavailable in the current source set.
            </p>
          </Reveal>
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
              Before work starts, a request becomes clear scope, acceptance
              criteria, and planned checks.
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
            <h2 className="text-heading-2 text-center">What your team gets back</h2>
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
              What has to be true before a PR reaches your team
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
            <h2 className="text-heading-2 text-center">
              Jace fits where agent work happens
            </h2>
          </Reveal>
          <Reveal delay={70}>
            <p className="mx-auto mt-4 max-w-[44ch] text-center text-[var(--gray-11)]">
              Jace fits where agent work happens. Bring a request from the
              channel your team already uses, then see evidence tied to the
              exact change.
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

      {/* 6 — The acceptance spine, retaining the existing three-paper visual
          rhythm without misusing legacy factory run totals as trust proof. */}
      <section className="px-6 py-24 sm:py-32">
        <div className="mx-auto max-w-[760px]">
          <Reveal>
            <h2 className="text-heading-2 text-center">The acceptance spine</h2>
          </Reveal>
          <p className="ar-rise mx-auto mt-4 max-w-[56ch] text-center text-[var(--gray-11)]">
            One durable record carries intent, bounded context, exact PR
            identity, criterion evidence, correction delivery, and the human decision.
          </p>
          <div className="mt-14 flex flex-wrap items-start justify-center gap-6 sm:gap-8">
            {/* Cards stay inlined: the mono-on-data craft pin scans 300
                chars BACKWARD from each literal {stats.x} marker for a mono
                class, so the class must sit in the same JSX block. */}
            <Reveal>
              <div className="w-[168px] -rotate-2 rounded-lg border-2 border-[var(--gray-13)] bg-[var(--paper)] px-5 py-6 text-center shadow-[4px_4px_0_0_var(--gray-13)] sm:w-[188px]">
                <p className="text-4xl font-mono font-bold text-[var(--gray-12)] sm:text-5xl">1</p>
                <p className="text-body-sm mt-2 text-[var(--gray-11)]">confirmed contract</p>
              </div>
            </Reveal>
            <Reveal delay={70}>
              <div className="w-[168px] translate-y-3 rotate-1 rounded-lg border-2 border-[var(--gray-13)] bg-[var(--paper)] px-5 py-6 text-center shadow-[4px_4px_0_0_var(--gray-13)] sm:w-[188px]">
                <p className="text-4xl font-mono font-bold text-[var(--gray-12)] sm:text-5xl">2</p>
                <p className="text-body-sm mt-2 text-[var(--gray-11)]">bounded Context Pack</p>
              </div>
            </Reveal>
            <Reveal delay={140}>
              <div className="w-[240px] rounded-lg border-2 border-[var(--gray-13)] bg-[var(--paper)] px-6 py-6 text-center shadow-[4px_4px_0_0_var(--gray-13)] sm:w-[260px]">
                <p className="text-4xl font-mono font-bold text-[var(--gray-12)] sm:text-5xl">3</p>
                <p className="mt-2 text-[var(--gray-11)]">exact-head review and human decision</p>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* 6b — Billing: company subscriptions (subscription-platform slice
          3, Task 7 — rollout rider, spec §9: the public surface stops
          promising "No seats, no subscription" the moment real
          subscriptions can be sold,
          docs/superpowers/specs/2026-07-29-subscription-platform-design.md).
          Fix round (coordinator call): the wallet-flow steps ("top up your
          balance... charged when the task is done") also contradicted the
          model one section under "One subscription for your whole team" —
          same category as the retired heading/claim, not approval-copy
          slice 6 owns, so they're rewritten too, in this page's own
          register (§6b stays declarative "you"-address, distinct from
          HOW_WE_WORK's first-person Jace voice above). Slice 10, Task 1
          (owner feedback 2026-08-02): the pricing itself now renders as
          the SAME full cards /pricing shows (TierCards,
          ./pricing/tier-cards.tsx) instead of slice 9's compact one-line
          summaries. The card grid sits as a SIBLING of the max-w-[560px]
          div below, not nested inside it — a narrower max-width ancestor
          caps every descendant's rendered width no matter what max-w a
          child itself carries, so the only way to actually reach ~960px is
          to escape that ancestor. /pricing's own page.tsx brackets this
          same grid between two max-w-[560px] elements for the identical
          reason; this section repeats that narrow/wide/narrow shape. */}
      <section className="px-6 pb-24 sm:pb-32">
        <div className="mx-auto max-w-[560px]">
          <Reveal>
            <h2 className="text-heading-2 text-center">
              One subscription for your whole team
            </h2>
          </Reveal>
          <Reveal delay={70}>
            <p className="mx-auto mt-4 max-w-[44ch] text-center text-[var(--gray-11)]">
              Plans are priced by team size. Starter is for small teams, Growth
              for bigger ones. The product is the acceptance and evidence
              layer around the coding agents your team already uses.
            </p>
          </Reveal>
          <ol className="mt-10 flex flex-col gap-6">
            {[
              "Pick a plan for your team size.",
              "Bring the request from the channel your team already uses when a verified connection is available.",
              "Confirm the Acceptance Contract and give the selected builder a bounded Context Pack.",
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
            <p className="mt-10 text-center text-[var(--gray-11)]">
            The point is less uncertainty at handoff and review, not another coding agent.
            </p>
          </Reveal>
        </div>
        <Reveal delay={310}>
          <div className="mx-auto mt-10 max-w-[960px]">
            <TierCards />
          </div>
        </Reveal>
        {/* Landing honesty rule (#1415) — ungated per the 2026-08-02 owner
            ruling: the /pricing page's own Live/Preview chip
            (./pricing/page.tsx) already carries the payment-honesty
            disclosure, so this link no longer needs its own gate on top of
            the tier cards above. */}
        <Reveal delay={380} className="mx-auto mt-6 max-w-[560px] text-center">
          <Link
            href="/pricing"
            className="text-body-sm rounded-sm text-[var(--gray-11)] transition-colors hover:text-[var(--accent-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gray-13)]"
          >
            See exact pricing
          </Link>
        </Reveal>
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
            Start with an approved change and see evidence attached to the result
            <span aria-hidden className="ar-cursor animate-pulse font-mono">
              _
            </span>
          </h2>
          <p className="mx-auto mt-4 max-w-[44ch] text-[var(--gray-11)]">
            Approve the change, then see evidence bound to the exact result.
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
            <Link href="/privacy" className="rounded-sm transition-colors hover:text-[var(--accent-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gray-13)]">
              Privacy
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
            © {new Date().getFullYear()} Jace
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

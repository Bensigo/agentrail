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
import { LANDING_CTA } from "./_cta";
import type { LandingCta } from "./_cta";
import { resolveDiscordChannelCard, resolveSlackChannelCard } from "./_channel-cards";
import { TierCards } from "./pricing/tier-cards";
// Shared tier card grid (subscription-platform slice 10, Task 1 — owner
// feedback 2026-08-02: the landing must show the FULL pricing cards, the
// same presentation /pricing renders, not slice 9's compact one-line tier
// summaries). Same TierCards component /pricing renders — see
// ./pricing/tier-cards.tsx's own doc-comment for why the grid lives in its
// own module rather than on either page.tsx file.


/**
 * The role split that makes Jace a trust layer rather than a coding agent.
 * The team owns intent and the decision; the external coding agent writes
 * code; Jace keeps the agreement, context, evidence, and correction path
 * connected between them.
 */
const HOW_WE_WORK = [
  {
    role: "YOUR TEAM",
    name: "Define the work",
    line: "Your team turns a request into scope, planned checks, and acceptance criteria. You confirm it before work starts.",
  },
  {
    role: "JACE + CODING AGENT",
    name: "Give the coding agent focused context",
    line: "Jace connects the confirmed agreement and relevant repository context to the external coding agent. The coding agent writes the code.",
  },
  {
    role: "JACE",
    name: "Verify and correct",
    line: "Jace checks the exact change against the agreed criteria, keeps the evidence, and sends a correction path when a claim is not proven.",
  },
  {
    role: "YOUR TEAM",
    name: "Human decides",
    line: "Your team reviews the change and criterion-specific evidence, then accepts, reworks, or rejects it.",
  },
];

/**
 * The secondary sign-in path (controller ruling, #1279 PR ①: "GitHub sign-in
 * demoted to nav + footer secondary"). Also the honest fallback for the
 * sign-in action, used only for secondary sign-in and channel setup paths.
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

  const cta = LANDING_CTA;
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
          floating pill with the primary project-setup CTA once the visitor
          scrolls into the story. See _nav.tsx. */}
      <MarketingNav cta={cta} signInAction={signInWithGithub} />

      {/* 2 — Hero: the centered stage (owner-chosen 2026-07-22, boardy's
          formula) — avatar disc, display headline, role line, ONE button.
          Nothing competes; the phone gets its own act below. */}
      <section id="landing-hero" className="px-6 pt-24 pb-16 text-center sm:pt-32 sm:pb-20">
        <div className="mx-auto flex max-w-[720px] flex-col items-center">
          <Image
            src="/jace-avatar.png"
            alt=""
            width={88}
            height={88}
            priority
            className="ar-rise rounded-full"
          />
          <h1 className="ar-rise mt-8 text-heading-1 text-balance" style={{ animationDelay: "60ms" }}>
            Approve agent work with confidence.
          </h1>
          <p className="ar-rise mt-6 max-w-[58ch] text-[var(--gray-11)]" style={{ animationDelay: "110ms" }}>
            Jace gives engineering teams the evidence and control they need to trust AI coding agents.
          </p>
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
              Before work starts, a request becomes planned scope and criteria for human confirmation.
            </p>
          </Reveal>
        </div>
      </section>

      {/* 3 — Use cases: a paper-card bento of the concrete ways Jace gives a
          team control over coding-agent work. */}
      <section className="px-6 pb-24 sm:pb-32">
        <div className="mx-auto max-w-[860px]">
          <Reveal>
            <h2 className="text-heading-2 text-center">What your team gets from Jace</h2>
          </Reveal>
        </div>
        <div className="mt-12">
          <UseCases />
        </div>
      </section>

      {/* 4 — The lemon band is the stack's next sheet. It makes the role
          split explicit without turning the handoff into a product diagram. */}
      <section className="relative -mt-16 w-full rounded-t-[2.5rem] border-t-2 border-[var(--gray-13)] bg-[var(--accent-fill)] px-6 py-24 sm:py-32">
        <div className="mx-auto max-w-[1120px]">
          <Reveal>
            <h2 className="text-heading-2 text-[var(--accent-fill-text)]">
              How Jace works with your team and coding agents
            </h2>
          </Reveal>
          <Reveal delay={70}>
            <p className="mt-4 max-w-[56ch] text-[var(--accent-fill-text)]">
              Your coding agent writes the code. Jace keeps the agreement, context, evidence, and corrections connected around it.
            </p>
          </Reveal>
          <ol className="mt-14 grid grid-cols-1 sm:mt-20 sm:grid-cols-2">
            {HOW_WE_WORK.map((step, i) => (
              <Reveal
                key={step.name}
                delay={i * 70}
                className="border-t-2 border-[var(--accent-fill-text)] py-8 first:border-t-0 first:pt-0 sm:odd:border-r-2 sm:odd:pr-10 sm:even:pl-10 sm:[&:nth-child(-n+2)]:border-t-0 sm:[&:nth-child(-n+2)]:pb-10 sm:[&:nth-child(n+3)]:pt-10 sm:[&:nth-child(n+3)]:pb-0"
              >
                <li>
                  <p className="text-mono-data text-[var(--accent-fill-text)]">{step.role}</p>
                  <h3 className="mt-4 text-heading-2 text-[var(--accent-fill-text)]">
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

      {/* 5b — Where Jace fits: coding agents lead; the chat channels remain
          secondary. See _channels.tsx. */}
      {/* The paper sheet rides over the lemon in turn — same sheet-over-
          sheet seam, so the acts hand off instead of hard-cutting. */}
      <section className="relative -mt-14 rounded-t-[2.5rem] border-t-2 border-[var(--gray-13)] bg-[var(--paper)] px-6 pt-20 pb-24 sm:pt-24 sm:pb-28">
        <div className="mx-auto max-w-[1120px]">
          <Reveal>
            <h2 className="text-heading-2 text-center">
              Jace fits where agent work already happens
            </h2>
          </Reveal>
          <Reveal delay={70}>
            <p className="mx-auto mt-4 max-w-[44ch] text-center text-[var(--gray-11)]">
              Start from the channel or coding agent your team already uses. Jace keeps the acceptance record and evidence connected.
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

      <section className="px-6 py-24 sm:py-32">
        <div className="mx-auto max-w-[560px]">
          <Reveal>
            <h2 className="text-heading-2 text-center">Evidence that changes the decision</h2>
          </Reveal>
          <p className="mx-auto mt-4 max-w-[44ch] text-center text-[var(--gray-11)]">
            Review the agreed criteria, the exact change, and the evidence for each claim before deciding what happens next.
          </p>
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
              A team commercial experiment
            </h2>
          </Reveal>
          <Reveal delay={70}>
            <p className="mx-auto mt-4 max-w-[44ch] text-center text-[var(--gray-11)]">
              These team-size terms are being evaluated commercially. They do
              not claim that Jace will generate code, deliver a pull request,
              or reduce review time.
            </p>
          </Reveal>
          <ol className="mt-10 flex flex-col gap-6">
            {[
              "Choose the team-size terms you want to discuss.",
              "Check the stated payment-availability status.",
              "Keep acceptance and delivery decisions with a human.",
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
              The point is to test a team commercial model, not to promise a product outcome.
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
            Start with an approved change
            <span aria-hidden className="ar-cursor animate-pulse font-mono">
              _
            </span>
          </h2>
          <p className="mx-auto mt-4 max-w-[44ch] text-[var(--gray-11)]">
            Start with a confirmed change and see evidence attached to the result.
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
 * The hero + closing primary CTA takes prospective users to the app's public
 * sign-in entry. Successful new sign-ins continue to workspace setup.
 */
/** The cartoon-ink press recipe (owner personality pass 2026-07-22): ink
 *  border + hard offset shadow; hover nudges into the shadow, active lands
 *  flat — a button that feels drawn, then pressed. */
const INK_BUTTON =
  "inline-flex items-center gap-2.5 rounded-md border-2 border-[var(--gray-13)] bg-[var(--accent-fill)] px-7 py-3.5 font-bold text-[var(--accent-fill-text)] shadow-[4px_4px_0_0_var(--gray-13)] transition-[transform,background-color,box-shadow] duration-150 ease-out hover:translate-x-[2px] hover:translate-y-[2px] hover:bg-[var(--accent-fill-hover)] hover:shadow-[2px_2px_0_0_var(--gray-13)] active:translate-x-[4px] active:translate-y-[4px] active:shadow-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gray-13)]";

function PrimaryCta({ cta }: { cta: LandingCta }) {
  return (
    <Link href={cta.href} className={INK_BUTTON}>
      <Send size={17} aria-hidden />
      {cta.label}
    </Link>
  );
}

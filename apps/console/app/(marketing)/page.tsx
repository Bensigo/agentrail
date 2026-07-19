import { auth, signIn } from "@agentrail/auth";
import { listWorkspacesForUser, claimInvitesForUser } from "@agentrail/db-postgres";
import { redirect } from "next/navigation";
import Link from "next/link";
import type { CSSProperties } from "react";
import { Send } from "lucide-react";
import { Reveal } from "./_motion";
import { ConversationDemo } from "./_conversation-demo";
import { resolveMessageJaceCta } from "./_cta";
import type { MessageJaceCta } from "./_cta";

/** Real dogfood track record — full autonomous runs of AgentRail on its own
 *  backlog (issue → implementation → review → PR), not a retrieval benchmark.
 *  Source: docs/benchmarks/results/dogfood-track-record.md. */
const TRACK_RECORD = { shipped: 33, attempted: 53, failed: 20 };

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
  ["--brand-accent" as string]: "#9e6c00",
} as CSSProperties;

/** What Jace does — three plain-spoken lines, first person, no mechanism sprawl. */
const JACE_DOES = [
  "I work your GitHub and Linear issues overnight. You wake up to pull requests, not a running agent to babysit.",
  "I never grade my own work: nothing counts as done until a second model and your own tests both agree, and nothing merges without you.",
  "I run under a hard budget: cheap models first, and I escalate only when a task earns it. Your spend never runs away.",
];

/**
 * How we work together — the real loop, in order (controller ruling, #1279
 * PR ②: "issue→brief→approve→PR→you merge; merge-permission opt-in is now
 * TRUE and worth saying"). Merge permission is a real, live, owner-only
 * toggle (Settings → Permissions), off by default — so "you merge" stays
 * the honest default step, and step 5 states the opt-in without overclaiming
 * it as automatic. See apps/console/app/api/v1/runner/result/route.ts for
 * the actual enforcement this line describes.
 */
const HOW_WE_WORK = [
  "You message me a task, or hand me a GitHub issue.",
  "I reply with a brief before I touch any code: task type, model, and a dollar estimate.",
  "You approve. That confirms the run's budget.",
  "I open a pull request against your repo.",
  "You merge it, or turn on merge permission in Settings so I can merge it myself once the gate is green.",
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

  return (
    <main
      id="top"
      style={LIGHT_SURFACE}
      className="relative min-h-screen bg-[var(--gray-00)] text-[var(--gray-12)]"
    >
      {/* 1 — Minimal nav: wordmark left, one primary CTA right */}
      <header className="mx-auto flex h-16 max-w-[1120px] items-center justify-between px-6">
        <a href="#top" className="flex items-center gap-2.5">
          <RailMark />
          <span className="font-bold tracking-tight">Jace</span>
        </a>
        <form action={signInWithGithub}>
          <button
            type="submit"
            className="text-body-sm rounded-md border border-[var(--gray-06)] bg-[var(--gray-02)] px-3.5 py-1.5 text-[var(--gray-11)] transition-colors hover:border-[var(--gray-08)] hover:text-[var(--gray-12)]"
          >
            Sign in
          </button>
        </form>
      </header>

      {/* 2 — Hero: conversational, first person, one CTA, lots of air */}
      <section className="px-6 pt-24 pb-16 text-center sm:pt-32 sm:pb-24">
        <div className="mx-auto max-w-[760px]">
          <h1 className="ar-rise text-heading-1 mx-auto max-w-[16ch] text-balance font-bold">
            Hi, I&apos;m Jace. I clear your backlog while you sleep.
          </h1>

          <p
            className="ar-rise mx-auto mt-6 max-w-[52ch] text-[var(--gray-10)]"
            style={{ animationDelay: "90ms" }}
          >
            Hire me as a fractional engineer. I triage your issues, write the
            code, and open a pull request. Then I wait for your review before
            anything ships.
          </p>

          <div
            className="ar-rise mt-9 flex flex-col items-center gap-3"
            style={{ animationDelay: "170ms" }}
          >
            <PrimaryCta cta={cta} />
            <FreePreviewChip />
          </div>
        </div>
      </section>

      {/* 3 — Trust strip: one honest credibility line (no fabricated logos) */}
      <section className="px-6 pb-20">
        <p className="mx-auto max-w-[64ch] text-balance text-center text-[var(--gray-10)]">
          I&apos;ve taken{" "}
          <span className="font-mono font-bold text-[var(--gray-12)]">
            {TRACK_RECORD.shipped}
          </span>{" "}
          issues from open to a reviewed PR on my own backlog, unattended. I
          count the{" "}
          <span className="font-mono font-bold text-[var(--gray-12)]">
            {TRACK_RECORD.failed}
          </span>{" "}
          that didn&apos;t land, too.
        </p>
      </section>

      {/* 4 — What Jace does: three one-line value points */}
      <section className="px-6 pb-24 sm:pb-32">
        <div className="mx-auto max-w-[720px]">
          <Reveal>
            <h2 className="text-heading-2 text-center font-bold">What I do</h2>
          </Reveal>
          <ul className="mt-12 flex flex-col gap-8">
            {JACE_DOES.map((line, i) => (
              <Reveal key={i} delay={i * 90}>
                <li className="flex items-start gap-4">
                  <span
                    aria-hidden
                    className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--brand-accent)]"
                  />
                  <p className="text-[var(--gray-11)]">{line}</p>
                </li>
              </Reveal>
            ))}
          </ul>
        </div>
      </section>

      {/* 5 — One product visual: a real Jace conversation, not a dashboard
          mockup. Every field Jace's reply shows — task type, suggested
          model, the $ estimate — is computed live by the real estimate lib,
          and the outcome ping is byte-identical to what the product actually
          sends. See _conversation-demo-data.ts. */}
      <section className="px-6 pb-28 sm:pb-36">
        <Reveal className="mx-auto max-w-[1080px]">
          <div className="overflow-hidden rounded-xl border border-[var(--gray-05)] shadow-[0_25px_50px_-12px_rgba(0,0,0,0.25)]">
            <ConversationDemo />
          </div>
        </Reveal>
      </section>

      {/* 6 — How we work together: the exact loop, in order. See HOW_WE_WORK's
          own comment above for why step 5 phrases merge permission as an
          opt-in rather than the default. */}
      <section className="px-6 pb-24 sm:pb-32">
        <div className="mx-auto max-w-[640px]">
          <Reveal>
            <h2 className="text-heading-2 text-center font-bold">How we work together</h2>
          </Reveal>
          <ol className="mt-12 flex flex-col gap-6">
            {HOW_WE_WORK.map((line, i) => (
              <Reveal key={i} delay={i * 70}>
                <li className="flex items-start gap-4">
                  <span
                    aria-hidden
                    className="text-label mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--brand-accent)] font-mono text-[var(--brand-accent)]"
                  >
                    {i + 1}
                  </span>
                  <p className="text-[var(--gray-11)]">{line}</p>
                </li>
              </Reveal>
            ))}
          </ol>
        </div>
      </section>

      {/* 7 — Closing CTA + minimal footer */}
      <section className="px-6 pb-24 text-center">
        <Reveal className="mx-auto max-w-[620px]">
          <h2 className="text-heading-2 font-bold">Point me at a repo.</h2>
          <p className="mx-auto mt-4 max-w-[44ch] text-[var(--gray-10)]">
            Connect a repo, hand me an issue, and wake up to a reviewed PR.
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
            <RailMark />
            <span className="font-bold tracking-tight">Jace</span>
          </div>
          <nav className="text-body-sm flex items-center gap-6 text-[var(--gray-10)]">
            <Link href="/docs" className="transition-colors hover:text-[var(--brand-accent)]">
              Docs
            </Link>
            <a
              href="https://github.com/Bensigo/agentrail"
              className="transition-colors hover:text-[var(--brand-accent)]"
            >
              GitHub
            </a>
            <a
              href="https://github.com/Bensigo/agentrail#cli"
              className="transition-colors hover:text-[var(--brand-accent)]"
            >
              CLI
            </a>
            <form action={signInWithGithub}>
              <button
                type="submit"
                className="text-body-sm text-[var(--gray-10)] transition-colors hover:text-[var(--brand-accent)]"
              >
                Sign in
              </button>
            </form>
          </nav>
          <span className="text-label text-[var(--gray-09)]">
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
        className="inline-flex items-center gap-2.5 rounded-md bg-[var(--yellow-09)] px-7 py-3.5 font-bold text-[var(--gray-13)] transition-all duration-200 hover:-translate-y-0.5 hover:opacity-95 active:scale-[0.97]"
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
        className="inline-flex items-center gap-2.5 rounded-md bg-[var(--yellow-09)] px-7 py-3.5 font-bold text-[var(--gray-13)] transition-all duration-200 hover:-translate-y-0.5 hover:opacity-95 active:scale-[0.97]"
      >
        <GitHubIcon />
        Sign in with GitHub
      </button>
    </form>
  );
}

/** The "Free while in preview" highlight — a lemon-fill chip (TASTE.md's
 *  fill-with-dark-text rule), not a plain caption. Shared by the hero and
 *  closing CTA rows so both stay byte-identical. */
function FreePreviewChip() {
  return (
    <span className="text-label inline-flex items-center rounded-full bg-[var(--yellow-09)] px-3 py-1 text-[var(--gray-13)]">
      Free while in preview
    </span>
  );
}

/* ---------------------------------------------------------------- icons */

function RailMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="3" y="2" width="2.4" height="16" rx="1.2" fill="var(--brand-accent)" />
      <rect x="14.6" y="2" width="2.4" height="16" rx="1.2" fill="var(--brand-accent)" />
      <rect x="2" y="6" width="16" height="1.6" rx="0.8" fill="var(--gray-08)" />
      <rect x="2" y="12.4" width="16" height="1.6" rx="0.8" fill="var(--gray-08)" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg height="18" width="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

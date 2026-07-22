"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { Send } from "lucide-react";
import type { MessageJaceCta } from "./_cta";

/**
 * The landing nav (owner-directed narrative-flow redo, wave 4 — Parker's
 * nav move, translated). Plain and inline at the very top of the page,
 * exactly like the pre-redo nav. Once the visitor scrolls past the top
 * sentinel, it condenses into a floating pill and swaps the secondary
 * "Sign in" link for the primary Message-Jace CTA — the action worth
 * surfacing once someone has actually committed to reading the story.
 *
 * Scroll state: a passive scroll listener + rAF read with a hysteresis
 * band (condense > 96px, expand < 64px) — see the effect's own comment
 * for why this replaced the IO sentinel. Both states pin the same h-12,
 * so the swap never changes the header's flow height; the container
 * MORPHS between row and pill (max-width/padding over 200ms strong
 * ease-out — a single small element, so the layout transition is
 * imperceptible as work and reads as one shape changing instead of two
 * layouts teleporting).
 */
export function MarketingNav({
  cta,
  signInAction,
}: {
  cta: MessageJaceCta;
  signInAction: () => Promise<void>;
}) {
  const [condensed, setCondensed] = useState(false);

  // Deterministic scroll latch with a hysteresis band (owner glitch fix
  // 2026-07-22): the old IntersectionObserver sentinel could miss a jump
  // (restored scroll, programmatic jumps, HMR) and stick in the wrong
  // state. A passive listener + rAF read self-corrects on every scroll
  // AND on mount; condense past 96px, expand only back above 64px, so
  // trackpad jitter at the boundary can't flicker the pill. Same
  // rAF-scroll pattern as _channels.tsx.
  useEffect(() => {
    // No rAF hop: scroll events are already frame-coalesced, React batches
    // the functional set, and the latch flips at most twice per journey.
    const onScroll = () => {
      const y = window.scrollY;
      setCondensed((prev) => (prev ? y > 64 : y > 96));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <>
      <header className="sticky top-3 z-40 px-6">
        {/* Both states share one morphing container (owner fix 2026-07-22:
            the instant swap read as a glitch — elements teleported between
            the full-width row and the pill). max-width/padding morph over
            200ms strong ease-out; this is a single small element, so the
            layout-property transition costs nothing perceptible. */}
        <div
          className={
            condensed
              ? "mx-auto flex h-12 max-w-[380px] items-center justify-between gap-4 rounded-full border-2 border-[var(--gray-13)] bg-[var(--gray-00)] pl-4 pr-2 shadow-[4px_4px_0_0_var(--gray-13)] transition-[max-width,padding,background-color,border-color,box-shadow] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]"
              : "mx-auto flex h-12 max-w-[1120px] items-center justify-between rounded-full border-2 border-transparent px-0 transition-[max-width,padding,background-color,border-color,box-shadow] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]"
          }
        >
          <a href="#top" className="flex shrink-0 items-center gap-2.5">
            {/* The mascot IS Jace (TASTE.md canon) — the wordmark beside it
                carries the name, so the render stays decorative for AT. */}
            <Image
              src="/jace-avatar.png"
              alt=""
              width={24}
              height={24}
              className="rounded-full"
            />
            <span className="font-bold tracking-tight">Jace</span>
          </a>

          {condensed ? (
            <CondensedCta cta={cta} signInAction={signInAction} />
          ) : (
            <form action={signInAction}>
              <button
                type="submit"
                className="text-body-sm rounded-md border border-[var(--gray-06)] bg-[var(--gray-02)] px-3.5 py-1.5 text-[var(--gray-11)] transition-colors hover:border-[var(--gray-08)] hover:text-[var(--gray-12)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gray-13)]"
              >
                Sign in
              </button>
            </form>
          )}
        </div>
      </header>
    </>
  );
}

/** The condensed pill's primary action — Message Jace on Telegram when the
 *  hosted bot is configured, the same honest sign-in fallback otherwise
 *  (never a dead link), mirroring `PrimaryCta` in `page.tsx` at nav scale. */
function CondensedCta({
  cta,
  signInAction,
}: {
  cta: MessageJaceCta;
  signInAction: () => Promise<void>;
}) {
  const classes =
    "inline-flex items-center gap-1.5 rounded-full bg-[var(--accent-fill)] px-3.5 py-1.5 font-bold text-[var(--accent-fill-text)] transition-colors hover:bg-[var(--accent-fill-hover)] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gray-13)]";
  if (cta.kind === "telegram") {
    return (
      <a href={cta.href} target="_blank" rel="noreferrer" className={classes}>
        <Send size={14} aria-hidden />
        Message Jace
      </a>
    );
  }
  return (
    <form action={signInAction}>
      <button type="submit" className={classes}>
        Sign in
      </button>
    </form>
  );
}

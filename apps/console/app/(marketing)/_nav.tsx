"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Send } from "lucide-react";
import type { LandingCta } from "./_cta";

/**
 * The landing nav (owner-directed narrative-flow redo, wave 4 — Parker's
 * nav move, translated). Plain and inline at the very top of the page,
 * exactly like the pre-redo nav. Once the visitor scrolls past the top
 * sentinel, it condenses into a floating pill and swaps the secondary
 * "Sign in" link for the primary project-setup CTA — the action worth
 * surfacing once someone has actually committed to reading the story.
 *
 * Scroll state: a passive scroll listener watches the hero's bottom edge.
 * The CTA appears only after that hero has cleared the header, so it never
 * sits over the headline or hero action. Both states pin the same h-12, so
 * the swap never changes the header's flow height; the container
 * MORPHS between row and pill (max-width/padding over 200ms strong
 * ease-out — a single small element, so the layout transition is
 * imperceptible as work and reads as one shape changing instead of two
 * layouts teleporting).
 */
export function MarketingNav({
  cta,
  signInAction,
}: {
  cta: LandingCta;
  signInAction: () => Promise<void>;
}) {
  const [condensed, setCondensed] = useState(false);

  // Deterministic scroll latch with a hysteresis band: the old
  // IntersectionObserver sentinel could miss a jump (restored scroll,
  // programmatic jumps, HMR) and stick in the wrong state. Reading the
  // hero's actual viewport edge on scroll and resize keeps the condensed
  // CTA out of the hero while avoiding flicker at the handoff.
  useEffect(() => {
    const onScroll = () => {
      const heroBottom = document.getElementById("landing-hero")?.getBoundingClientRect().bottom;
      if (heroBottom === undefined) return;
      setCondensed((prev) => (prev ? heroBottom < 64 : heroBottom < 0));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return (
    <>
      <header className="sticky top-3 z-40 px-3 sm:px-6">
        {/* Both states share one morphing container (owner fix 2026-07-22:
            the instant swap read as a glitch — elements teleported between
            the full-width row and the pill). max-width/padding morph over
            200ms strong ease-out; this is a single small element, so the
            layout-property transition costs nothing perceptible. */}
        <div
          className={
            condensed
              ? "mx-auto flex h-12 w-full max-w-[440px] items-center justify-between gap-2 rounded-full border-2 border-[var(--gray-13)] bg-[var(--gray-00)] pl-3 pr-2 shadow-[4px_4px_0_0_var(--gray-13)] transition-[max-width,padding,background-color,border-color,box-shadow] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] sm:gap-3 sm:pl-4"
              : "mx-auto flex h-12 max-w-[1120px] items-center justify-between rounded-full border-2 border-transparent px-0 transition-[max-width,padding,background-color,border-color,box-shadow] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]"
          }
        >
          <a href="#top" aria-label="Jace home" className="flex shrink-0 items-center gap-2.5">
            {/* The mascot IS Jace (TASTE.md canon) — the wordmark beside it
                carries the name, so the render stays decorative for AT. */}
            <Image
              src="/jace-avatar.png"
              alt=""
              width={24}
              height={24}
              className="rounded-full"
            />
            <span className="hidden font-bold tracking-tight sm:inline">Jace</span>
          </a>

          {condensed ? (
            <CondensedCta cta={cta} />
          ) : (
            <div className="flex items-center gap-4">
              {/* Pricing (subscription-platform slice 7, Task 2): ungated —
                  unlike page.tsx's "See exact pricing" link, this one isn't
                  gated behind isPricingClaimLive(). It makes no pricing
                  claim itself; /pricing self-discloses its own Preview
                  state via its own chip. Full-row only — the condensed pill
                  keeps its single tuned primary action untouched. */}
              <Link
                href="/pricing"
                className="text-body-sm rounded-sm px-2 text-[var(--gray-11)] transition-colors hover:text-[var(--accent-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gray-13)]"
              >
                Pricing
              </Link>
              <form action={signInAction}>
                <button
                  type="submit"
                  className="text-body-sm rounded-md border border-[var(--gray-06)] bg-[var(--gray-02)] px-3.5 py-1.5 text-[var(--gray-11)] transition-colors hover:border-[var(--gray-08)] hover:text-[var(--gray-12)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gray-13)]"
                >
                  Sign in
                </button>
              </form>
            </div>
          )}
        </div>
      </header>
    </>
  );
}

/** The condensed pill mirrors the primary project-setup CTA in `page.tsx`. */
function CondensedCta({ cta }: { cta: LandingCta }) {
  const classes =
    "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-[var(--accent-fill)] px-3 py-1.5 text-body-sm font-bold text-[var(--accent-fill-text)] transition-colors hover:bg-[var(--accent-fill-hover)] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gray-13)] sm:px-3.5 sm:text-base";
  return (
    <Link href={cta.href} className={classes}>
      <Send size={14} aria-hidden />
      {cta.label}
    </Link>
  );
}

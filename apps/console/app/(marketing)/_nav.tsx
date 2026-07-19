"use client";

import { useEffect, useRef, useState } from "react";
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
 * Scroll state comes from one IntersectionObserver watching a 32px
 * sentinel at the top of `<main>`, not a `scroll` event listener — no
 * wheel interception anywhere in this narrative redo, matching
 * `_scroll-narrative.tsx`'s own convention. The sentinel's height IS the
 * hysteresis band (review fix M-3): the pill condenses only once the
 * whole sentinel has scrolled past (`bottom < 0`) and expands only once
 * it is fully back (`top >= 0`); in between, the state holds, so
 * trackpad jitter at the boundary can't flicker the nav. Both states pin
 * the same h-12, so the swap never changes the header's flow height and
 * the document doesn't nudge at the boundary; the swap itself is an
 * instant className change (no width/padding transition — animating
 * those is a layout-thrash pattern the house motion rules ban); only
 * color and shadow cross-fade.
 */
export function MarketingNav({
  cta,
  signInAction,
}: {
  cta: MessageJaceCta;
  signInAction: () => Promise<void>;
}) {
  const [condensed, setCondensed] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        const rect = entry.boundingClientRect;
        if (rect.bottom < 0) setCondensed(true);
        else if (rect.top >= 0) setCondensed(false);
        // Partially visible: hold the current state (the hysteresis band).
      },
      { threshold: [0, 1] }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <>
      <div ref={sentinelRef} aria-hidden className="pointer-events-none absolute top-0 h-8 w-full" />
      <header className="sticky top-3 z-40 px-6">
        <div
          className={
            condensed
              ? "mx-auto flex h-12 max-w-[380px] items-center justify-between gap-4 rounded-full border border-[var(--gray-06)] bg-[var(--gray-00)] pl-4 pr-2 shadow-[0_10px_15px_-3px_rgb(0_0_0_/_0.1),0_4px_6px_-4px_rgb(0_0_0_/_0.1)] transition-[background-color,border-color,box-shadow] duration-200"
              : "mx-auto flex h-12 max-w-[1120px] items-center justify-between transition-[background-color,border-color,box-shadow] duration-200"
          }
        >
          <a href="#top" className="flex shrink-0 items-center gap-2.5">
            <RailMark />
            <span className="font-bold tracking-tight">Jace</span>
          </a>

          {condensed ? (
            <CondensedCta cta={cta} signInAction={signInAction} />
          ) : (
            <form action={signInAction}>
              <button
                type="submit"
                className="text-body-sm rounded-md border border-[var(--gray-06)] bg-[var(--gray-02)] px-3.5 py-1.5 text-[var(--gray-11)] transition-colors hover:border-[var(--gray-08)] hover:text-[var(--gray-12)]"
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
    "inline-flex items-center gap-1.5 rounded-full bg-[var(--accent-fill)] px-3.5 py-1.5 font-bold text-[var(--accent-fill-text)] transition-colors hover:bg-[var(--accent-fill-hover)] active:scale-[0.97]";
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

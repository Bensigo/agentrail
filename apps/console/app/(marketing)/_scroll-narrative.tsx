"use client";

import { useEffect, useRef, useState } from "react";
import { ConversationDemo } from "./_conversation-demo";
import { DEMO_USER_MESSAGE } from "./_conversation-demo-data";

/** Total typewriter duration for the user message — a self-paced timer
 *  ("time-based on first view", not scrubbed to scroll pixels, so pacing
 *  stays even regardless of scroll speed). Capped well under the point
 *  where a ~95-char message would feel sluggish. */
const TYPEWRITER_MS = 1400;

/**
 * True only once mounted AND eligible: motion isn't reduced, and the
 * viewport is wide enough to pin comfortably (spec: "Mobile: graceful — pin
 * only where viewport allows, else static"). Starts `false` so the very
 * first paint — server-rendered and the client's first frame — is always
 * the plain, fully-visible static render; it only upgrades to the pinned
 * scene after mount confirms eligibility. Re-evaluates live if the visitor
 * resizes the window or flips their OS motion setting mid-session.
 */
function usePlaysScrollNarrative(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const reduceMq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const widthMq = window.matchMedia("(min-width: 768px)");
    const update = () => setEnabled(!reduceMq.matches && widthMq.matches);
    update();
    reduceMq.addEventListener("change", update);
    widthMq.addEventListener("change", update);
    return () => {
      reduceMq.removeEventListener("change", update);
      widthMq.removeEventListener("change", update);
    };
  }, []);
  return enabled;
}

/** Fires once, the first time the returned ref's element scrolls into
 *  view — the same "reveal once" contract `<Reveal>` uses in `_motion.tsx`,
 *  applied to a zero-height scroll trigger instead of visible content.
 *  Never un-fires on scroll-up, so stages only ever move forward. */
function useScrollTrigger() {
  const ref = useRef<HTMLDivElement>(null);
  const [reached, setReached] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setReached(true);
          io.disconnect();
        }
      },
      { threshold: 0 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, reached] as const;
}

/**
 * Act 1's centerpiece (owner-directed narrative-flow redo, wave 4): the
 * same `ConversationDemo` — same computed brief, same drift-guarded outcome
 * ping, same required Approve tap — pinned inside a tall scroll region
 * (native `position: sticky`, no wheel interception, no scroll-jacking) so
 * the conversation plays as the visitor scrolls: the message types out,
 * then Jace's brief rises in. Two scroll-triggered latches drive it, each
 * an IntersectionObserver on a zero-height sentinel positioned partway
 * down the pin track.
 *
 * Stages only ever move forward and a later stage force-completes the
 * earlier one (`briefStarted` alone flips the message to fully-typed) —
 * so a fast scroll straight through the section still lands on the
 * finished setup ("scroll past = complete"), and scrolling back up never
 * un-plays a beat.
 *
 * Below `md` or under `prefers-reduced-motion`, this renders the exact
 * unpinned `<ConversationDemo />` — today's shipped markup, full message,
 * brief, and Approve button all visible immediately, no scroll or motion
 * required.
 */
export function PinnedConversationScene() {
  const playsNarrative = usePlaysScrollNarrative();
  const [typingRef, typingStarted] = useScrollTrigger();
  const [briefRef, briefStarted] = useScrollTrigger();
  const [typedChars, setTypedChars] = useState(0);

  useEffect(() => {
    if (!typingStarted) return;
    const total = DEMO_USER_MESSAGE.length;
    const start = performance.now();
    const msPerChar = TYPEWRITER_MS / total;
    let raf = requestAnimationFrame(function tick(now) {
      const chars = Math.min(total, Math.floor((now - start) / msPerChar));
      setTypedChars((prev) => Math.max(prev, chars));
      if (chars < total) raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [typingStarted]);

  const cardClassName =
    "mx-auto w-full max-w-[1080px] overflow-hidden rounded-xl border border-[var(--gray-05)] shadow-[0_25px_50px_-12px_rgba(0,0,0,0.25)]";

  if (!playsNarrative) {
    return (
      <div className={cardClassName}>
        <ConversationDemo />
      </div>
    );
  }

  const total = DEMO_USER_MESSAGE.length;
  const messageComplete = typedChars >= total || briefStarted; // scroll past = complete
  const effectiveTypedChars = messageComplete ? total : typedChars;

  return (
    <div className="relative h-[240vh]">
      <div ref={typingRef} aria-hidden className="absolute inset-x-0 top-[12%] h-px" />
      <div ref={briefRef} aria-hidden className="absolute inset-x-0 top-[50%] h-px" />
      <div className="sticky top-0 flex h-screen items-center justify-center px-6">
        <div className={cardClassName}>
          <ConversationDemo typedChars={effectiveTypedChars} briefRevealed={briefStarted} />
        </div>
      </div>
    </div>
  );
}

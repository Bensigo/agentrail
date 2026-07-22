"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { ChevronLeft, Paperclip, Mic, Smile } from "lucide-react";
import { ConversationDemo } from "./_conversation-demo";
import { DEMO_USER_MESSAGE } from "./_conversation-demo-data";
import { TELEGRAM_SURFACE } from "../../lib/telegram-surface";

/**
 * The hero's phone — landing v2's device-as-stage (heyparker's Macintosh
 * move at our scale; see docs/superpowers/plans/2026-07-22-landing-v2.md).
 * Hosts the SAME drift-guarded `ConversationDemo` the retired pinned scene
 * used, but drives its `typedChars`/`briefRevealed` choreography with a
 * timer once the phone is actually in view, instead of taxing 2,486px of
 * scroll. The Approve tap stays `ConversationDemo`'s own real click —
 * "nothing merges without you" forbids a scripted approval (controller
 * ruling, 2026-07-19).
 *
 * Reduced motion (or no IntersectionObserver): render with no props, which
 * `ConversationDemo` documents as "show everything immediately".
 */

/** ms per typed character — the full DEMO_USER_MESSAGE lands in ~2.4s. */
const TYPE_INTERVAL_MS = 24;
/** Pause between the message finishing and Jace's brief rising in. */
const BRIEF_DELAY_MS = 350;

export function PhoneDemo() {
  const frameRef = useRef<HTMLDivElement>(null);
  const [choreographed, setChoreographed] = useState<boolean | null>(null);
  const [typed, setTyped] = useState(0);
  const [briefRevealed, setBriefRevealed] = useState(false);

  useEffect(() => {
    if (
      typeof IntersectionObserver === "undefined" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setChoreographed(false);
      return;
    }
    setChoreographed(true);
    const el = frameRef.current;
    if (!el) return;

    let typeTimer: ReturnType<typeof setInterval> | undefined;
    let briefTimer: ReturnType<typeof setTimeout> | undefined;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        io.disconnect();
        typeTimer = setInterval(() => {
          setTyped((n) => {
            if (n >= DEMO_USER_MESSAGE.length) {
              clearInterval(typeTimer);
              briefTimer = setTimeout(() => setBriefRevealed(true), BRIEF_DELAY_MS);
              return n;
            }
            return n + 1;
          });
        }, TYPE_INTERVAL_MS);
      },
      { threshold: 0.4 }
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (typeTimer) clearInterval(typeTimer);
      if (briefTimer) clearTimeout(briefTimer);
    };
  }, []);

  // Telegram chrome matched to the owner's REAL iOS screenshot of the Jace
  // bot chat (2026-07-22): green doodle-wallpaper gradient, translucent
  // centered header (chevron left, name+bot centered, avatar RIGHT), white
  // incoming / green outgoing bubbles, floating paperclip–Message–mic input
  // row. Colors come exclusively from the TELEGRAM_SURFACE vars
  // (lib/telegram-surface.ts) applied on the frame; the ink cartoon frame
  // around it stays OURS. The translucent blur layers are justified real
  // layering — they depict iOS chrome floating over the wallpaper.
  // Decorative chrome is aria-hidden: it illustrates the app, it is not an
  // interface.
  return (
    <div
      ref={frameRef}
      style={TELEGRAM_SURFACE}
      className="w-[320px] overflow-hidden rounded-[2rem] border-2 border-[var(--gray-13)] shadow-[6px_6px_0_0_var(--gray-13)] sm:w-[350px]"
    >
      {/* iOS floating header (owner reference, round 3): three LIQUID-GLASS
          islands over the wallpaper — translucent fill, bright glass edge,
          soft depth — chevron pill left, name pill truly centered, avatar
          in its own glass ring right. Cluster sits 10px lower per the
          reference. */}
      <div className="flex items-center justify-between px-3 pt-5 pb-1">
        {/* 50px slot mirrors the ringed avatar so the name pill centers
            EXACTLY on the frame axis (justify-between math). */}
        <span aria-hidden className="flex w-[50px] shrink-0 justify-start">
          <span className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--gray-00)]/70 bg-[var(--gray-00)]/55 text-[var(--gray-13)] shadow-[0_4px_14px_rgba(30,70,50,0.16)] backdrop-blur-md">
            <ChevronLeft size={22} />
          </span>
        </span>
        <span className="flex flex-col items-center rounded-full border border-[var(--gray-00)]/70 bg-[var(--gray-00)]/55 px-7 py-1 leading-tight shadow-[0_4px_14px_rgba(30,70,50,0.16)] backdrop-blur-md">
          <span className="font-bold text-[var(--gray-13)]">Jace</span>
          <span className="text-label text-[var(--gray-11)]">bot</span>
        </span>
        <span className="shrink-0 rounded-full border border-[var(--gray-00)]/70 bg-[var(--gray-00)]/45 p-[3px] shadow-[0_4px_14px_rgba(30,70,50,0.16)] backdrop-blur-md">
          <Image
            src="/jace-avatar.png"
            alt=""
            width={44}
            height={44}
            className="rounded-full"
          />
        </span>
      </div>

      {/* Fixed conversation height (owner fix 2026-07-22): the frame is
          full-size from first paint — typing, the brief, and the outcome
          ping all land INSIDE it instead of growing the phone stepwise. */}
      <div className="min-h-[560px]">
        {choreographed === null ? null : choreographed ? (
          <ConversationDemo typedChars={typed} briefRevealed={briefRevealed} />
        ) : (
          <ConversationDemo />
        )}
      </div>

      {/* Floating input row — decorative, completes the iOS picture. */}
      <div aria-hidden className="flex items-center gap-2 px-3 pt-1 pb-3 text-[var(--gray-11)]">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--gray-00)]/80">
          <Paperclip size={18} />
        </span>
        <span className="flex h-9 flex-1 items-center justify-between rounded-full bg-[var(--gray-00)]/80 px-4">
          Message
          <Smile size={18} />
        </span>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--gray-00)]/80">
          <Mic size={18} />
        </span>
      </div>
    </div>
  );
}

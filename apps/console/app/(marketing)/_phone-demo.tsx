"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { ChevronLeft, MoreVertical, Smile, Paperclip, Mic } from "lucide-react";
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

  // Telegram chrome (owner directive 2026-07-22): the demo reads as the
  // REAL channel Jace lives on — blue app bar, cool chat backdrop, message
  // input row — familiar at a glance. Colors come exclusively from the
  // TELEGRAM_SURFACE vars (lib/telegram-surface.ts) applied on the frame;
  // the ink cartoon frame around it stays OURS. Decorative chrome (back
  // chevron, menu, input row) is aria-hidden: it illustrates the app, it
  // is not an interface.
  return (
    <div
      ref={frameRef}
      style={TELEGRAM_SURFACE}
      className="w-[340px] overflow-hidden rounded-[2rem] border-2 border-[var(--gray-13)] bg-[var(--tg-bg)] shadow-[6px_6px_0_0_var(--gray-13)] sm:w-[400px]"
    >
      <div className="flex items-center gap-2.5 bg-[var(--tg-header)] px-3 py-2.5 text-[var(--tg-header-text)]">
        <ChevronLeft size={20} aria-hidden className="shrink-0" />
        <Image src="/jace-avatar.png" alt="" width={32} height={32} className="rounded-full" />
        <div className="flex min-w-0 flex-col">
          <span className="font-bold leading-tight">Jace</span>
          <span className="text-label opacity-75">bot</span>
        </div>
        <MoreVertical size={18} aria-hidden className="ml-auto shrink-0 opacity-90" />
      </div>

      {/* Fixed conversation height (owner fix 2026-07-22): the frame is
          full-size from first paint — typing, the brief, and the outcome
          ping all land INSIDE it instead of growing the phone stepwise. */}
      <div className="min-h-[530px]">
        {choreographed === null ? null : choreographed ? (
          <ConversationDemo typedChars={typed} briefRevealed={briefRevealed} />
        ) : (
          <ConversationDemo />
        )}
      </div>

      {/* Message input row — decorative, completes the Telegram picture. */}
      <div aria-hidden className="flex items-center gap-3 border-t border-[var(--gray-04)] bg-[var(--gray-00)] px-4 py-2.5 text-[var(--gray-11)]">
        <Smile size={20} className="shrink-0" />
        <span className="flex-1 text-left">Message</span>
        <Paperclip size={19} className="shrink-0" />
        <Mic size={20} className="shrink-0" />
      </div>
    </div>
  );
}

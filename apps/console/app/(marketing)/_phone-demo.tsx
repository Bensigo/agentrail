"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { ConversationDemo } from "./_conversation-demo";
import { DEMO_USER_MESSAGE } from "./_conversation-demo-data";

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

  return (
    <div
      ref={frameRef}
      className="w-[340px] overflow-hidden rounded-[2rem] border-2 border-[var(--gray-13)] bg-[var(--gray-01)] shadow-[6px_6px_0_0_var(--gray-13)] sm:w-[400px]"
    >
      {/* Chat header — Jace's identity row, not a cloned Telegram chrome. */}
      <div className="flex items-center gap-2.5 border-b border-[var(--gray-04)] bg-[var(--gray-00)] px-4 py-3">
        <Image src="/jace-avatar.png" alt="" width={28} height={28} className="rounded-full" />
        <div className="flex flex-col">
          <span className="font-bold leading-tight text-[var(--gray-12)]">Jace</span>
          <span className="text-label text-[var(--gray-11)]">online</span>
        </div>
      </div>

      {/* Fixed conversation height (owner fix 2026-07-22): the frame is
          full-size from first paint — typing, the brief, and the outcome
          ping all land INSIDE it instead of growing the phone stepwise. */}
      <div className="min-h-[510px] bg-[var(--gray-01)]">
        {choreographed === null ? null : choreographed ? (
          <ConversationDemo typedChars={typed} briefRevealed={briefRevealed} />
        ) : (
          <ConversationDemo />
        )}
      </div>
    </div>
  );
}

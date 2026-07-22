"use client";

import { useState } from "react";
import Image from "next/image";
import { CheckCircle2, CheckCheck } from "lucide-react";
import {
  DEMO_TASK_INPUT,
  DEMO_USER_MESSAGE,
  getDemoBrief,
  getDemoOutcomeMessage,
} from "./_conversation-demo-data";

/**
 * The landing page's centerpiece (#1279 PR ①, replacing `_dashboard-demo.tsx`,
 * TASTE.md's landing directive: "a real chat conversation with Jace — never
 * a dashboard mockup"). A visitor didn't really send this message, but every
 * FIELD in Jace's reply is the real product's own render: task type,
 * suggested model, and the ~$ estimate are computed live by the real
 * estimate lib, and the run-outcome ping below is byte-identical to what
 * `buildOutcomeMessage` actually sends over Telegram — see
 * `_conversation-demo-data.ts` for the drift-guarded numbers, and
 * `apps/console/lib/approval-message.ts`'s `renderAlignmentBrief` for the
 * real chat rendering this mirrors. The "✅ Approve" button's wording matches
 * the real Telegram inline keyboard exactly (`.../connectors/secret/telegram.ts`,
 * which also renders a "❌ Deny" button not reproduced here — this demo only
 * walks the approve path).
 *
 * Console tokens only, no raw hex (guarded by `tokens-only.test.ts`). The
 * outcome ping's entrance uses `.ar-rise-fast` (<300ms, ease-out) — a state
 * change, not a scroll reveal, so it's deliberately faster than the page's
 * `<Reveal>` wrapper around this whole component.
 *
 * Two optional choreography props (owner-directed narrative-flow redo, wave
 * 4): `typedChars` and `briefRevealed`, driven by `_scroll-narrative.tsx`'s
 * pinned scroll scene. Both default to "show everything immediately", so
 * `<ConversationDemo />` with no props (the reduced-motion and
 * mobile-static fallback) renders content-equivalent to what shipped
 * before this change — same copy, values, and interaction; the entrance
 * classes below apply only when the scroll scene drives them. The Approve
 * tap itself is deliberately NOT choreographed or auto-fired by scroll:
 * the page's own claim is "nothing ships without you," so the one place a
 * visitor could mistake a scripted animation for their own action is
 * exactly the one beat that stays a real, required click.
 */
export function ConversationDemo({
  typedChars,
  briefRevealed = true,
}: {
  /** Reveals the user message character-by-character. Omit for the full
   *  message immediately. */
  typedChars?: number;
  /** Gates Jace's brief bubble's entrance so it rises in after the message
   *  finishes typing rather than alongside it. Omit (default) to show it
   *  immediately. */
  briefRevealed?: boolean;
} = {}) {
  const [approved, setApproved] = useState(false);
  const brief = getDemoBrief();
  const choreographed = typedChars !== undefined;
  const isTyping = choreographed && typedChars < DEMO_USER_MESSAGE.length;
  const shownMessage = DEMO_USER_MESSAGE.slice(0, typedChars ?? DEMO_USER_MESSAGE.length);

  // Telegram bubble language (owner directive 2026-07-22): the outgoing
  // message in the classic green with a bottom tail + read checks, incoming
  // in white — colors via the frame's --tg-* vars (lib/telegram-surface.ts),
  // never hex here (tokens-only pin).
  return (
    <div className="flex flex-col gap-5 px-5 py-6 sm:px-8 sm:py-8">
      {/* The user's message — typed out character-by-character when
          `typedChars` is provided; the full message immediately otherwise.
          The 18:02 + double-check trailer appears once the message has
          fully "sent" (outgoing-only, like the real client). */}
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-[var(--tg-bubble-out)] px-4 py-2.5 text-[var(--gray-12)]">
          {shownMessage}
          {isTyping ? (
            <span aria-hidden className="animate-pulse">
              ▍
            </span>
          ) : (
            <span
              aria-hidden
              className="text-label ml-2 inline-flex translate-y-0.5 items-center gap-1 whitespace-nowrap text-[var(--gray-11)]"
            >
              18:02
              <CheckCheck size={14} className="text-[var(--tg-check)]" />
            </span>
          )}
        </p>
      </div>

      {/* Jace's alignment brief — always in the DOM from first paint
          (review fix I-2: heading navigation, End-key jumps, and
          find-in-page must reach the page's centerpiece before the scroll
          sentinel fires, so a conditional mount is not allowed here).
          Visibility is gated exactly the way `_motion.tsx`'s <Reveal>
          gates its children: mounted at opacity-0 + a small translate,
          latched to shown — opacity/transform only, never a layout
          property, and no aria-hidden (Reveal-wrapped content elsewhere
          on this page is likewise exposed while visually pending). The
          .ar-rise-fast entrance runs when the scroll scene latches
          `briefRevealed`; outside the choreographed scene the block
          renders plainly, matching the pre-redo markup. The mascot avatar
          is decorative here (alt="") because the visible "Jace" sender
          label already names him; screen readers shouldn't hear
          "Jace Jace". */}
      <div
        className={
          briefRevealed
            ? choreographed
              ? "ar-rise-fast flex flex-col items-start gap-1.5"
              : "flex flex-col items-start gap-1.5"
            : "flex translate-y-2.5 flex-col items-start gap-1.5 opacity-0"
        }
      >
        <span className="text-label flex items-center gap-1.5 px-1 text-[var(--gray-11)]">
          <Image src="/jace.png" alt="" width={20} height={20} className="rounded-full" />
          Jace
        </span>
        <div className="w-full max-w-[92%] rounded-2xl rounded-bl-sm bg-[var(--gray-00)] px-4 py-3.5 sm:max-w-[80%]">
          <p className="font-bold text-[var(--gray-12)]">{DEMO_TASK_INPUT.title}</p>
          <p className="text-mono-data mt-2 font-mono text-[var(--gray-11)]">
            Task type: {brief.taskType} → suggested model: {brief.suggestedModel.displayName}
          </p>
          <p className="text-mono-data mt-1.5 font-mono text-[var(--gray-11)]">
            Approving sets this run&apos;s budget: ~${brief.estimateUsd.toFixed(2)}
          </p>
        </div>

        {/* The inline keyboard — how the REAL bot renders Approve
            (.../connectors/secret/telegram.ts sends an inline keyboard):
            a translucent full-width row BELOW the message, accent text.
            Still the visitor's own real click, never auto-fired. */}
        {!approved ? (
          <button
            type="button"
            onClick={() => setApproved(true)}
            className="mt-1 w-full max-w-[92%] rounded-lg bg-[var(--gray-00)]/85 py-2 text-center font-bold text-[var(--tg-accent)] transition-[transform,opacity] duration-150 ease-out hover:opacity-90 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--tg-accent)] sm:max-w-[80%]"
          >
            ✅ Approve
          </button>
        ) : (
          <p className="text-label mt-1 flex w-full max-w-[92%] items-center justify-center gap-1.5 py-2 text-[var(--green-11)] sm:max-w-[80%]">
            <CheckCircle2 size={13} aria-hidden />
            Approved by you
          </p>
        )}
      </div>

      {/* Run-outcome ping — the real wire format, once approved. The
          aria-live wrapper stays mounted from first render (not inside the
          conditional) so screen readers reliably announce the ping when it
          appears after the Approve click. */}
      <div aria-live="polite">
        {approved ? (
          <div className="ar-rise-fast flex items-end justify-start gap-2">
            <Image
              src="/jace.png"
              alt=""
              width={20}
              height={20}
              className="mb-0.5 shrink-0 rounded-full"
            />
            {/* break-all: the ping carries a full PR URL, which must wrap
                inside the hero phone's narrow bubble instead of clipping.
                Plain incoming white bubble — Telegram doesn't color-border
                messages; the mono wire text carries the moment. */}
            <p className="text-mono-data max-w-[92%] break-all rounded-2xl rounded-bl-sm bg-[var(--gray-00)] px-4 py-2.5 font-mono text-[var(--gray-12)] sm:max-w-[80%]">
              {getDemoOutcomeMessage()}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

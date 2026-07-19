"use client";

import { useState } from "react";
import { CheckCircle2 } from "lucide-react";
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
 */
export function ConversationDemo() {
  const [approved, setApproved] = useState(false);
  const brief = getDemoBrief();

  return (
    <div className="flex flex-col gap-5 bg-[var(--gray-01)] px-5 py-6 sm:px-8 sm:py-8">
      {/* The user's message */}
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-tr-sm bg-[var(--gray-05)] px-4 py-2.5 text-[13px] leading-relaxed text-[var(--gray-12)]">
          {DEMO_USER_MESSAGE}
        </p>
      </div>

      {/* Jace's alignment brief */}
      <div className="flex flex-col items-start gap-1.5">
        <span className="px-1 text-[11px] font-medium text-[var(--gray-09)]">Jace</span>
        <div className="w-full max-w-[92%] rounded-2xl rounded-tl-sm border border-[var(--gray-05)] bg-[var(--gray-00)] px-4 py-3.5 sm:max-w-[80%]">
          <p className="text-[13.5px] font-semibold leading-snug text-[var(--gray-12)]">
            {DEMO_TASK_INPUT.title}
          </p>
          <p className="mt-2 font-mono text-[12px] text-[var(--gray-10)]">
            Task type: {brief.taskType} → suggested model: {brief.suggestedModel.displayName}
          </p>
          <p className="mt-1.5 font-mono text-[12px] text-[var(--gray-11)]">
            Approving sets this run&apos;s budget: ~${brief.estimateUsd.toFixed(2)}
          </p>

          {!approved ? (
            <button
              type="button"
              onClick={() => setApproved(true)}
              className="mt-3.5 inline-flex items-center gap-1.5 rounded-md bg-[var(--brand-accent)] px-3.5 py-1.5 text-[12.5px] font-semibold text-white transition-transform duration-150 ease-out hover:opacity-90 active:scale-[0.97]"
            >
              ✅ Approve
            </button>
          ) : (
            <p className="mt-3.5 flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--green-11)]">
              <CheckCircle2 size={13} aria-hidden />
              Approved by you
            </p>
          )}
        </div>
      </div>

      {/* Run-outcome ping — the real wire format, once approved. The
          aria-live wrapper stays mounted from first render (not inside the
          conditional) so screen readers reliably announce the ping when it
          appears after the Approve click. */}
      <div aria-live="polite">
        {approved ? (
          <div className="ar-rise-fast flex justify-start">
            <p className="max-w-[92%] rounded-2xl rounded-tl-sm border border-[var(--green-11)] bg-[var(--gray-00)] px-4 py-2.5 font-mono text-[12px] leading-relaxed text-[var(--gray-12)] sm:max-w-[80%]">
              {getDemoOutcomeMessage()}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import Image from "next/image";
import { CheckCircle2, CheckCheck } from "lucide-react";
import { DEMO_CONTRACT, DEMO_USER_MESSAGE, getDemoFollowUpMessage } from "./_conversation-demo-data";

/** A small illustrative conversation showing Jace's acceptance layer. */
export function ConversationDemo({
  typedChars,
  briefRevealed = true,
}: { typedChars?: number; briefRevealed?: boolean } = {}) {
  const [confirmed, setConfirmed] = useState(false);
  const choreographed = typedChars !== undefined;
  const isTyping = choreographed && typedChars < DEMO_USER_MESSAGE.length;
  const shownMessage = DEMO_USER_MESSAGE.slice(0, typedChars ?? DEMO_USER_MESSAGE.length);

  return (
    <div className="flex flex-col gap-4 px-4 py-5 sm:px-6 sm:py-6">
      <div aria-hidden className="flex justify-center"><span className="text-label rounded-full bg-[var(--tg-pill)] px-3 py-1 font-bold text-[var(--gray-00)]">Today</span></div>
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-[var(--tg-bubble-out)] px-4 py-2.5 text-[var(--gray-12)]">
          {shownMessage}
          {isTyping ? <span aria-hidden className="animate-pulse">▍</span> : <span aria-hidden className="text-label ml-2 inline-flex translate-y-0.5 items-center gap-1 whitespace-nowrap text-[var(--gray-11)]">6:08 PM <CheckCheck size={14} className="text-[var(--tg-check)]" /></span>}
        </p>
      </div>
      <div className={briefRevealed ? choreographed ? "ar-rise-fast flex flex-col items-start gap-1.5" : "flex flex-col items-start gap-1.5" : "flex translate-y-2.5 flex-col items-start gap-1.5 opacity-0"}>
        <span className="text-label flex items-center gap-1.5 px-1 text-[var(--gray-11)]"><Image src="/jace.png" alt="" width={20} height={20} className="rounded-full" />Jace</span>
        <div className="w-full max-w-[92%] rounded-2xl rounded-bl-sm bg-[var(--gray-00)] px-4 py-3.5 sm:max-w-[80%]">
          <p className="font-bold text-[var(--gray-12)]">{DEMO_CONTRACT.title}</p>
          <p className="text-mono-data mt-2 font-mono text-[var(--gray-11)]">Goal: {DEMO_CONTRACT.goal}</p>
          <p className="text-mono-data mt-1.5 font-mono text-[var(--gray-11)]">Boundary: {DEMO_CONTRACT.boundary}</p>
          <p className="text-mono-data mt-1.5 font-mono text-[var(--gray-11)]">Checkable criteria:</p>
          <ul className="text-mono-data mt-1 list-disc pl-5 font-mono text-[var(--gray-11)]">{DEMO_CONTRACT.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul>
          <span aria-hidden className="text-label mt-1 block text-right text-[var(--gray-11)]">6:08 PM</span>
        </div>
        {!confirmed ? <button type="button" onClick={() => setConfirmed(true)} className="mt-1 w-full max-w-[92%] rounded-lg bg-[var(--gray-00)]/85 py-2 text-center font-bold text-[var(--tg-accent)] transition-[transform,opacity] duration-150 ease-out hover:opacity-90 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--tg-accent)] sm:max-w-[80%]">✅ Confirm contract</button> : <p className="text-label mt-1 flex w-full max-w-[92%] items-center justify-center gap-1.5 py-2 text-[var(--green-11)] sm:max-w-[80%]"><CheckCircle2 size={13} aria-hidden />Contract confirmed by you</p>}
      </div>
      <div aria-live="polite">{confirmed ? <div className="ar-rise-fast flex items-end justify-start gap-2"><Image src="/jace.png" alt="" width={20} height={20} className="mb-0.5 shrink-0 rounded-full" /><p className="text-mono-data max-w-[92%] rounded-2xl rounded-bl-sm bg-[var(--gray-00)] px-4 py-2.5 font-mono text-[var(--gray-12)] sm:max-w-[80%]">{getDemoFollowUpMessage()} <span aria-hidden className="text-label ml-2 whitespace-nowrap text-[var(--gray-11)]">6:09 PM</span></p></div> : null}</div>
    </div>
  );
}

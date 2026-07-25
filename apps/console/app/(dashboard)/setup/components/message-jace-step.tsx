"use client";

import { useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { linkedIdentitiesLine } from "../../../../lib/linked-identities";
import {
  resolveHostedBotUsername,
  telegramDeepLink,
  SELF_HOST_TELEGRAM_DOCS_URL,
} from "../../../../lib/telegram-bot";

/**
 * The onboarding wizard's `message-jace` step — the owner-ruled merge of the
 * old "Connect a channel" and "Say hi to Jace" steps ("that split is the
 * redundancy"). Complete once the workspace has a linked Telegram identity
 * OR Jace has ever replied in console chat; either proves the user reached
 * him (see `onboarding-data.ts`). Optional, like every step in this wizard —
 * skippable, and the skip is remembered per workspace.
 */
export function MessageJaceStep({
  workspaceId,
  connected,
  skipped,
  linkedNames,
  jaceReplied,
  onChanged,
}: {
  workspaceId: string;
  connected: boolean;
  skipped: boolean;
  linkedNames: (string | null)[];
  jaceReplied: boolean;
  onChanged: () => void;
}) {
  // Hosted deploys set this so this step's incomplete render offers a
  // "message the shared bot" deep link — self-host default (unset) falls
  // back to an honest notice instead of a dead t.me/undefined href.
  const hostedBotUsername = resolveHostedBotUsername(
    process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME
  );
  const [skipping, setSkipping] = useState(false);
  // Whether to show the connect affordance instead of the "Skipped for now"
  // summary. Starts open unless the workspace already skipped; "Connect now"
  // flips it back.
  const [showConnect, setShowConnect] = useState(!skipped);

  async function handleSkip() {
    setSkipping(true);
    try {
      // Route path predates this step's rename (see skip-channel/route.ts's
      // own doc-comment) — same underlying mechanism, unchanged.
      await fetch(`/api/v1/workspaces/${workspaceId}/onboarding/skip-channel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skip: true }),
      });
      onChanged();
    } finally {
      setSkipping(false);
    }
  }

  if (connected) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-[var(--gray-10)]">
        <CheckCircle2 size={13} className="text-[var(--green-11)]" />
        {linkedNames.length > 0
          ? `Telegram connected · ${linkedIdentitiesLine(linkedNames)}`
          : jaceReplied
            ? "Jace replied — you're talking."
            : "Connected."}
      </p>
    );
  }

  if (skipped && !showConnect) {
    return (
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-[var(--gray-09)]">
          Skipped for now. You can message Jace any time from Gateways.
        </p>
        <button
          type="button"
          onClick={() => setShowConnect(true)}
          className="shrink-0 text-xs text-[var(--blue-11)] hover:underline"
        >
          Connect now
        </button>
      </div>
    );
  }

  if (hostedBotUsername) {
    return (
      <div className="flex flex-col gap-2.5">
        <p className="text-xs leading-relaxed text-[var(--gray-09)]">
          Message Jace on Telegram — that chat becomes your channel, no token
          to paste, and Jace replies right there.
        </p>
        {/* font-bold: primary CTA (colored fill) — the emphasis case. */}
        <a
          href={telegramDeepLink(hostedBotUsername)}
          target="_blank"
          rel="noreferrer"
          className="flex h-8 w-full items-center justify-center rounded bg-[var(--brand-accent)] px-3 text-xs font-bold text-black transition-colors hover:opacity-90"
        >
          Message @{hostedBotUsername} on Telegram
        </a>
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-[var(--gray-09)]">
            Self-hosting?{" "}
            <a
              href={SELF_HOST_TELEGRAM_DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="text-[var(--blue-11)] hover:underline"
            >
              Bring your own bot
            </a>
          </p>
          {/* font-normal: secondary button, matches the Deny/Refresh/Requeue
              plain-weight convention used across the scope. */}
          <button
            type="button"
            onClick={handleSkip}
            disabled={skipping}
            className="shrink-0 h-8 rounded border border-[var(--gray-06)] bg-[var(--gray-03)] px-3 text-xs font-normal text-[var(--gray-12)] hover:border-[var(--gray-08)] transition-colors disabled:opacity-50"
          >
            {skipping ? "Skipping…" : "Skip for now"}
          </button>
        </div>
      </div>
    );
  }

  // Honest fallback (self-host default, env unset): no shared bot to
  // deep-link to. Say so directly instead of rendering a dead
  // t.me/undefined href, and point at the one way to make the link real.
  return (
    <div className="flex items-center justify-between gap-2">
      <p className="text-xs leading-relaxed text-[var(--gray-09)]">
        Telegram messaging isn&apos;t set up for this deployment yet.{" "}
        <a
          href={SELF_HOST_TELEGRAM_DOCS_URL}
          target="_blank"
          rel="noreferrer"
          className="text-[var(--blue-11)] hover:underline"
        >
          Bring your own bot
        </a>
      </p>
      <button
        type="button"
        onClick={handleSkip}
        disabled={skipping}
        className="shrink-0 h-8 rounded border border-[var(--gray-06)] bg-[var(--gray-03)] px-3 text-xs font-normal text-[var(--gray-12)] hover:border-[var(--gray-08)] transition-colors disabled:opacity-50"
      >
        {skipping ? "Skipping…" : "Skip for now"}
      </button>
    </div>
  );
}

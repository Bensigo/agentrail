"use client";

import { useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { linkedIdentitiesLine } from "@/(dashboard)/dashboard/[workspaceId]/connectors/components/connector-helpers";
import {
  resolveHostedBotUsername,
  telegramDeepLink,
  SELF_HOST_TELEGRAM_DOCS_URL,
} from "./channel-step-helpers";

export function ChannelStep({
  workspaceId,
  connected,
  skipped,
  linkedNames,
  onChanged,
}: {
  workspaceId: string;
  connected: boolean;
  skipped: boolean;
  linkedNames: (string | null)[];
  onChanged: () => void;
}) {
  // Hosted deploys set this (issue #1262 PR ③) to flip this step's incomplete
  // render from the self-host docs pointer to a "message the shared bot" deep
  // link — self-host default (unset) keeps the docs-pointer branch below.
  const hostedBotUsername = resolveHostedBotUsername(
    process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME
  );
  const [skipping, setSkipping] = useState(false);
  // Whether to show the connect affordance (the hosted deep-link CTA or the
  // self-host docs line) instead of the "Skipped for now" summary. Starts
  // open unless the workspace already skipped; "Connect now" flips it back.
  const [showConnect, setShowConnect] = useState(!skipped);

  async function handleSkip() {
    setSkipping(true);
    try {
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
        Telegram connected · {linkedIdentitiesLine(linkedNames)}
      </p>
    );
  }

  if (skipped && !showConnect) {
    return (
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-[var(--gray-09)]">
          Skipped for now. You can connect a channel any time from Connectors.
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
          Talk to Jace on Telegram. Message the bot once — that chat becomes
          your channel, no token to paste.
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

  // Self-host default (env unset): no shared bot to deep-link to. A quiet
  // docs pointer instead of a dead CTA — same treatment as the connectors
  // page's fully-self-host branch (connectors-panel.tsx's ChannelManage).
  return (
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
      {/* font-normal: secondary button, same convention as the hosted
          branch's Skip button above. */}
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

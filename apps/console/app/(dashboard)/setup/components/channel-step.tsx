"use client";

import { useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { validateConnectorCredential } from "@/(dashboard)/dashboard/[workspaceId]/connectors/components/connector-helpers";
import {
  resolveHostedBotUsername,
  telegramDeepLink,
  SELF_HOST_TELEGRAM_DOCS_URL,
} from "./channel-step-helpers";

export function ChannelStep({
  workspaceId,
  connected,
  skipped,
  chatId,
  onChanged,
}: {
  workspaceId: string;
  connected: boolean;
  skipped: boolean;
  chatId: string | null;
  onChanged: () => void;
}) {
  // Hosted deploys set this (issue #1262 PR ③) to flip this step's incomplete
  // render from the bring-your-own-bot form to a "message the shared bot"
  // deep link — self-host default (unset) keeps the form below unchanged.
  const hostedBotUsername = resolveHostedBotUsername(
    process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME
  );
  const [token, setToken] = useState("");
  const [chatIdInput, setChatIdInput] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(!skipped);

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    const check = validateConnectorCredential(
      "telegram",
      token,
      chatIdInput || undefined
    );
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/connectors/secret`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "telegram",
          secret: token.trim(),
          ...(chatIdInput.trim() ? { chatId: chatIdInput.trim() } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setToken("");
      setChatIdInput("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect Telegram");
    } finally {
      setConnecting(false);
    }
  }

  async function handleSkip() {
    setSkipping(true);
    setError(null);
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
        Telegram connected
        {chatId ? (
          <code className="font-mono text-[var(--gray-11)]">· {chatId}</code>
        ) : null}
      </p>
    );
  }

  if (skipped && !showForm) {
    return (
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-[var(--gray-09)]">
          Skipped for now. You can connect a channel any time from Connectors.
        </p>
        <button
          type="button"
          onClick={() => setShowForm(true)}
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
          Notify a Telegram chat when Jace ships or needs you. Message the
          bot below once — that chat becomes your connection, no token to
          paste.
        </p>
        <a
          href={telegramDeepLink(hostedBotUsername)}
          target="_blank"
          rel="noreferrer"
          className="flex h-8 w-full items-center justify-center rounded bg-[var(--brand-accent)] px-3 text-xs font-medium text-black transition-colors hover:opacity-90"
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
          <button
            type="button"
            onClick={handleSkip}
            disabled={skipping}
            className="shrink-0 h-8 rounded border border-[var(--gray-06)] bg-[var(--gray-03)] px-3 text-xs font-medium text-[var(--gray-12)] hover:border-[var(--gray-08)] transition-colors disabled:opacity-50"
          >
            {skipping ? "Skipping…" : "Skip for now"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleConnect} className="flex flex-col gap-2.5">
      <p className="text-xs leading-relaxed text-[var(--gray-09)]">
        Notify a Telegram chat when Jace ships or needs you. Message
        @BotFather → /newbot to get a token, then message your new bot once
        before connecting.
      </p>
      <input
        aria-label="Telegram bot token"
        type="password"
        autoComplete="off"
        placeholder="123456789:ABCdef…"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        className="h-8 w-full rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-2 font-mono text-xs text-[var(--gray-12)] placeholder:text-[var(--gray-07)] outline-none focus:border-[var(--gray-08)]"
      />
      <input
        aria-label="Chat id (optional)"
        type="text"
        placeholder="chat id — optional, blank for a direct chat"
        value={chatIdInput}
        onChange={(e) => setChatIdInput(e.target.value)}
        className="h-8 w-full rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-2 font-mono text-xs text-[var(--gray-12)] placeholder:text-[var(--gray-07)] outline-none focus:border-[var(--gray-08)]"
      />
      {error && <p className="text-xs text-[var(--red-11)]">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={connecting || !token.trim()}
          className="h-8 flex-1 rounded bg-[var(--brand-accent)] px-3 text-xs font-medium text-black transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {connecting ? "Connecting…" : "Connect"}
        </button>
        <button
          type="button"
          onClick={handleSkip}
          disabled={skipping}
          className="h-8 rounded border border-[var(--gray-06)] bg-[var(--gray-03)] px-3 text-xs font-medium text-[var(--gray-12)] hover:border-[var(--gray-08)] transition-colors disabled:opacity-50"
        >
          {skipping ? "Skipping…" : "Skip for now"}
        </button>
      </div>
    </form>
  );
}

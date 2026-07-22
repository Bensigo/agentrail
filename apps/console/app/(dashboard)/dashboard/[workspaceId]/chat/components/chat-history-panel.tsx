"use client";

import { useEffect } from "react";
import { Plus, X } from "lucide-react";
import { formatRelativeTime, type ChatThreadSummary } from "./chat-helpers";

/**
 * The chat history drawer (#1288 sessions UI) — a slide-over listing this
 * member's previous console chat threads (title + relative time), newest
 * first. Opened by the header's history icon; clicking a row switches the
 * active thread. Rendered as an overlay (backdrop + left panel) so it never
 * disturbs the full-bleed thread layout underneath, and closes on backdrop
 * click, Escape, ＋ New chat, or picking a thread.
 *
 * A brand-new, never-messaged thread is intentionally absent until its first
 * message materializes a row (matches ChatGPT) — the ＋ affordance opens one
 * as client state; it joins this list once sent.
 */
export function ChatHistoryPanel({
  open,
  onClose,
  threads,
  activeN,
  loading,
  onSelect,
  onNewChat,
}: {
  open: boolean;
  onClose: () => void;
  threads: readonly ChatThreadSummary[];
  activeN: number;
  loading: boolean;
  onSelect: (n: number) => void;
  onNewChat: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-40">
      {/* Backdrop — click to dismiss. */}
      <div
        className="absolute inset-0 bg-black/20"
        onClick={onClose}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-label="Chat history"
        className="absolute left-0 top-0 flex h-full w-72 flex-col border-r border-[var(--gray-05)] bg-[var(--gray-01)] shadow-2xl"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--gray-05)] px-3 py-2.5">
          <span className="text-xs font-bold text-[var(--gray-12)]">Chats</span>
          <button
            type="button"
            aria-label="Close history"
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded text-[var(--gray-09)] transition-colors hover:bg-[var(--gray-03)] hover:text-[var(--gray-12)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="shrink-0 px-2 py-2">
          <button
            type="button"
            onClick={onNewChat}
            className="flex w-full items-center gap-2 rounded-md border border-dashed border-[var(--gray-06)] px-2.5 py-2 text-left text-xs text-[var(--gray-11)] transition-colors hover:bg-[var(--gray-03)] hover:text-[var(--gray-12)]"
          >
            <Plus className="h-3.5 w-3.5 shrink-0" />
            New chat
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {loading && threads.length === 0 ? (
            <div className="flex flex-col gap-1.5 px-1 pt-1">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-9 animate-pulse rounded-md bg-[var(--gray-02)]" />
              ))}
            </div>
          ) : threads.length === 0 ? (
            <p className="px-2 pt-2 text-xs text-[var(--gray-08)]">No previous chats yet.</p>
          ) : (
            threads.map((t) => {
              const isActive = t.n === activeN;
              return (
                <button
                  key={t.n}
                  type="button"
                  onClick={() => onSelect(t.n)}
                  aria-current={isActive}
                  className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors ${
                    isActive ? "bg-[var(--gray-03)]" : "hover:bg-[var(--gray-02)]"
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-[var(--gray-12)]">
                    {t.title}
                  </span>
                  <span className="shrink-0 text-[10px] text-[var(--gray-08)]">
                    {formatRelativeTime(t.last_message_at)}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </aside>
    </div>
  );
}

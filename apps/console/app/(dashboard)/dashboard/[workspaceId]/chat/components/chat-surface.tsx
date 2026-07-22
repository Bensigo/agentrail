"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { History, SquarePen } from "lucide-react";
import { PageHeader } from "../../../../../components/page-header";
import type { ChatModelOption } from "../../../../../../lib/chat/models";
import { ChatThread } from "./chat-thread";
import { ModelPicker } from "./model-picker";
import { ChatHistoryPanel } from "./chat-history-panel";
import { nextThreadN, type ChatThreadSummary } from "./chat-helpers";

/**
 * The console chat surface shell (#1288 sessions + history + model picker) —
 * owns the cross-cutting state the header controls and the thread share:
 *   - `activeN` — which of this member's own threads (`console:<userId>:<n>`)
 *     is on screen. `ChatThread` is KEYED by it, so switching threads remounts
 *     the thread (fresh fetch + poll cursor) rather than trying to reconcile
 *     two conversations' message lists.
 *   - `threads` — the history list (`GET .../chat/threads`), refetched when a
 *     new thread materializes (its first message) so it joins history.
 *   - `selectedModel` — the header dropdown's pick, sent with each message.
 *
 * A brand-new "New chat" is pure client state: `activeN` jumps to
 * `nextThreadN(threads)` and the thread shows its empty state; no row exists
 * (and it isn't in `threads`) until the first send materializes it — matching
 * ChatGPT, where an untouched new chat isn't in history yet. No new table, no
 * migration: threads are derived from existing `jace_messages` rows.
 */
export function ChatSurface({
  workspaceId,
  models,
  defaultModelId,
}: {
  workspaceId: string;
  models: readonly ChatModelOption[];
  defaultModelId: string;
}) {
  const [threads, setThreads] = useState<ChatThreadSummary[]>([]);
  const [loadingThreads, setLoadingThreads] = useState(true);
  const [activeN, setActiveN] = useState(1);
  const [selectedModel, setSelectedModel] = useState(defaultModelId);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Only the FIRST threads load may move `activeN` (to the most recent thread);
  // later refetches must never yank the user off the thread they're reading.
  const initializedRef = useRef(false);

  const refreshThreads = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/chat/threads`);
      if (!res.ok) return;
      const body = (await res.json()) as { threads: ChatThreadSummary[] };
      setThreads(body.threads);
      if (!initializedRef.current) {
        initializedRef.current = true;
        // Open the most recent existing thread on first load; a member with no
        // threads yet starts on the default thread 1 (empty state).
        if (body.threads.length > 0 && body.threads[0]) setActiveN(body.threads[0].n);
      }
    } catch {
      // Silent — history is a convenience; a failure just leaves the list as-is.
    } finally {
      setLoadingThreads(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    refreshThreads();
  }, [refreshThreads]);

  function startNewChat() {
    setActiveN(nextThreadN(threads));
    setHistoryOpen(false);
  }

  function selectThread(n: number) {
    setActiveN(n);
    setHistoryOpen(false);
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-6 pt-5 pb-3">
        <PageHeader
          title="Chat"
          subtitle="Talk to Jace right from the dashboard."
          actions={
            <>
              <ModelPicker models={models} value={selectedModel} onChange={setSelectedModel} />
              <button
                type="button"
                aria-label="New chat"
                title="New chat"
                onClick={startNewChat}
                className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--gray-05)] bg-[var(--gray-02)] text-[var(--gray-11)] transition-colors hover:bg-[var(--gray-03)] hover:text-[var(--gray-12)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-text)]"
              >
                <SquarePen className="h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label="Chat history"
                title="Chat history"
                aria-expanded={historyOpen}
                onClick={() => setHistoryOpen((o) => !o)}
                className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--gray-05)] bg-[var(--gray-02)] text-[var(--gray-11)] transition-colors hover:bg-[var(--gray-03)] hover:text-[var(--gray-12)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-text)]"
              >
                <History className="h-4 w-4" />
              </button>
            </>
          }
        />
      </div>

      <ChatThread
        key={activeN}
        workspaceId={workspaceId}
        n={activeN}
        model={selectedModel}
        onMaterialize={refreshThreads}
      />

      <ChatHistoryPanel
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        threads={threads}
        activeN={activeN}
        loading={loadingThreads}
        onSelect={selectThread}
        onNewChat={startNewChat}
      />
    </div>
  );
}

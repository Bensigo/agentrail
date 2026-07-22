"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { ArrowUp } from "lucide-react";
import { mergeChatMessages, highestSeq, isAwaitingReply, type ChatMessage, type ChatApproval } from "./chat-helpers";
import { ChatMarkdown } from "./chat-markdown";

// Gentle enough not to hammer the poll endpoint, fast enough that Jace's
// reply shows up without a manual refresh — same order of magnitude as the
// onboarding wizard's own poll (4s) and the runs-detail timeline's (5s).
const POLL_INTERVAL_MS = 3000;

// A textarea taller than this scrolls internally rather than growing the
// composer further — keeps a very long paste from pushing the send button
// off-screen.
const COMPOSER_MAX_HEIGHT_PX = 160;

// Auto-scroll only when the reader is already near the bottom — a
// background poll landing a new Jace reply must never yank someone away
// from history they scrolled up to read.
const NEAR_BOTTOM_THRESHOLD_PX = 120;

/** Plain-English label for a gated tool name — mirrors the Approvals page's own `toolLabel` (duplicated, not imported: this component intentionally stays self-contained rather than reaching into the approvals feature folder for one string map). */
const TOOL_LABELS: Record<string, string> = {
  create_issue: "Create issue",
  create_workspace: "Create workspace",
  create_repo: "Create repo",
  alignment_brief: "Alignment brief",
};

function toolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? toolName;
}

/** A short one-line summary of a tool call's input, for the inline approval card. */
function summarizeToolInput(toolInput: Record<string, unknown>): string {
  const title = toolInput["title"] ?? toolInput["name"];
  if (typeof title === "string" && title.trim()) return title;
  const entries = Object.entries(toolInput).slice(0, 2);
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => `${k}: ${String(v)}`).join(", ");
}

function JaceAvatar({ className = "" }: { className?: string }) {
  return (
    <Image
      src="/jace.png"
      alt=""
      width={22}
      height={22}
      // Explicit h/w pins the box regardless of a `height: auto` reset
      // stretching it inside a `flex` row (Tailwind's preflight sets that on
      // every <img>; only `items-start` on the parent stops the stretch —
      // this is defense in depth so the avatar never depends on that alone).
      className={`h-[22px] w-[22px] shrink-0 rounded-full ${className}`}
    />
  );
}

/** The "Jace is working…" pending affordance — the POST returns before Jace replies, and the reply only shows up via the next poll, so without this the thread looks frozen (the current complaint this fixes). Never fakes token streaming (honest per the PR's design constraint); a soft pulse is enough to say "this is still alive". */
function ThinkingRow() {
  return (
    <div className="chat-msg-enter flex items-center gap-3">
      <JaceAvatar className="opacity-70" />
      <div className="flex items-center gap-2 text-sm text-[var(--gray-09)]">
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--gray-08)]" />
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--gray-08)] [animation-delay:150ms]" />
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--gray-08)] [animation-delay:300ms]" />
        </span>
        Jace is working…
      </div>
    </div>
  );
}

export function ChatThread({
  workspaceId,
  n,
  onMaterialize,
}: {
  workspaceId: string;
  /** Which of this member's own threads this view reads/sends to (`console:<userId>:<n>`). */
  n: number;
  /** Called after the FIRST message in a previously-empty thread lands — lets the
   * parent refresh the history list so the freshly-materialized thread appears. */
  onMaterialize?: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [approvals, setApprovals] = useState<ChatApproval[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const afterSeqRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  // Ids already rendered at least once — a message not yet in this set gets
  // the one-time `chat-msg-enter` fade so a poll landing several messages at
  // once doesn't replay the entrance on history that's already on screen.
  const seenIdsRef = useRef<Set<string>>(new Set());

  const poll = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/v1/workspaces/${workspaceId}/chat?n=${n}&after_seq=${afterSeqRef.current}`
      );
      if (!res.ok) return;
      const body = (await res.json()) as { messages: ChatMessage[]; approvals: ChatApproval[] };
      if (!mountedRef.current) return;
      if (body.messages.length > 0) {
        setMessages((prev) => {
          const merged = mergeChatMessages(prev, body.messages);
          afterSeqRef.current = highestSeq(merged);
          return merged;
        });
      }
      setApprovals(body.approvals);
      setError(null);
    } catch {
      // A poll failure is silent — the next tick retries. Only the
      // send-message path surfaces an error to the user.
    } finally {
      if (mountedRef.current) setLoaded(true);
    }
  }, [workspaceId, n]);

  useEffect(() => {
    mountedRef.current = true;
    poll();
    timerRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [poll]);

  // Mark every currently-rendered message as "seen" once the render
  // committed, so the NEXT render never re-plays its entrance animation.
  // Runs after every commit (no deps) — idempotent, since adding an
  // already-present id is a no-op.
  useEffect(() => {
    for (const m of messages) seenIdsRef.current.add(m.id);
  });

  const awaitingReply = isAwaitingReply(messages, approvals);

  // Background poll arrivals only scroll when the reader is already near the
  // bottom (see NEAR_BOTTOM_THRESHOLD_PX's own comment) — checked fresh each
  // time rather than memoized, since scroll position is a live DOM read.
  useEffect(() => {
    const el = scrollRef.current;
    const nearBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_THRESHOLD_PX;
    if (nearBottom) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages.length, approvals.length, awaitingReply]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT_PX)}px`;
  }, [input]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;
    // A previously-empty thread becomes real with this send — notify the
    // parent afterward so the freshly-materialized thread joins history.
    const wasEmpty = messages.length === 0;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, n }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        message?: ChatMessage;
        error?: string;
      };
      if (!res.ok || !body.message) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setMessages((prev) => {
        const merged = mergeChatMessages(prev, [body.message!]);
        afterSeqRef.current = highestSeq(merged);
        return merged;
      });
      setInput("");
      if (wasEmpty) onMaterialize?.();
      // The member's own send always scrolls to bottom regardless of
      // current scroll position — sending is a deliberate action, unlike a
      // background poll arrival, which respects NEAR_BOTTOM_THRESHOLD_PX.
      requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  }

  function handleComposerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      formRef.current?.requestSubmit();
    }
  }

  // Same seam every approval resolves through, everywhere in the console —
  // POST /api/v1/workspaces/:workspaceId/approvals/:id (see
  // pending-approvals-list.tsx's own `decide`). This inline card is a SECOND
  // renderer of that one seam, not a second resolution mechanism.
  async function decide(id: string, decision: "approved" | "denied") {
    setDecidingId(id);
    try {
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/approvals/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (res.ok) {
        setApprovals((prev) => prev.filter((a) => a.id !== id));
      }
    } finally {
      setDecidingId(null);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6 sm:px-8">
        <div className="mx-auto flex max-w-[720px] flex-col gap-6">
          {!loaded ? (
            <div className="flex flex-col gap-4">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-12 w-2/3 animate-pulse rounded-xl bg-[var(--gray-02)]" />
              ))}
            </div>
          ) : messages.length === 0 && approvals.length === 0 ? (
            <p className="text-sm text-[var(--gray-09)]">
              Say hi — Jace is listening. Ask it to check on a run, kick off work, or just say
              hello.
            </p>
          ) : (
            <>
              {messages.map((m) => {
                const isNew = !seenIdsRef.current.has(m.id);
                return m.role === "user" ? (
                  <div key={m.id} className={`flex justify-end ${isNew ? "chat-msg-enter" : ""}`}>
                    <p className="max-w-[75%] whitespace-pre-wrap rounded-2xl bg-[var(--gray-04)] px-4 py-2.5 text-sm text-[var(--gray-12)]">
                      {m.text}
                    </p>
                  </div>
                ) : (
                  <div key={m.id} className={`flex items-start gap-3 ${isNew ? "chat-msg-enter" : ""}`}>
                    <JaceAvatar className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <ChatMarkdown text={m.text} workspaceId={workspaceId} />
                    </div>
                  </div>
                );
              })}

              {approvals.map((a) => (
                <div key={a.id} className="flex items-start gap-3">
                  <JaceAvatar className="mt-0.5" />
                  <div className="flex min-w-0 flex-1 flex-col gap-2.5 rounded-xl border border-[var(--gray-05)] bg-[var(--gray-02)] px-4 py-3.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex shrink-0 items-center rounded-md border border-[var(--gray-06)] bg-[var(--gray-03)] px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide text-[var(--gray-10)]">
                        {toolLabel(a.tool_name)}
                      </span>
                      <span className="text-sm text-[var(--gray-12)]">
                        {summarizeToolInput(a.tool_input)}
                      </span>
                    </div>
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => decide(a.id, "denied")}
                        disabled={decidingId === a.id}
                        className="h-7 rounded-md border border-[var(--gray-06)] bg-[var(--gray-03)] px-2.5 text-xs text-[var(--red-11)] transition-colors hover:border-[var(--red-09)]/50 disabled:opacity-50"
                      >
                        Deny
                      </button>
                      <button
                        type="button"
                        onClick={() => decide(a.id, "approved")}
                        disabled={decidingId === a.id}
                        className="h-7 rounded-md bg-[var(--green-09)] px-2.5 text-xs font-bold text-white transition-colors hover:bg-[var(--green-11)] disabled:opacity-50"
                      >
                        {decidingId === a.id ? "Working…" : "Approve"}
                      </button>
                    </div>
                  </div>
                </div>
              ))}

              {awaitingReply && <ThinkingRow />}
            </>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="p-3 sm:px-8 sm:py-4">
        <form ref={formRef} onSubmit={handleSend} className="mx-auto max-w-[720px]">
          {/* One unified pill (ChatGPT/Claude style) — the send button lives
              INSIDE this container, pinned to the bottom-right corner via
              `absolute`, rather than sitting beside it as a separate sibling
              (that two-element layout is what caused the earlier vertical
              misalignment). `pr-12` reserves room on the right so the
              textarea's own text never runs under the button; as the
              textarea grows across multiple rows the container grows with
              it and the button stays anchored to its bottom-right corner.
              Tokens are NOT invented for this component — they're the exact
              bg/border/focus recipe this same composer already used before
              this rework (`bg-[var(--gray-02)]`, `border-[var(--gray-05)]`,
              focus border-shift to `--gray-08`; the dialog-form input recipe
              elsewhere in this app, e.g. add-repository-dialog.tsx, adds a
              ring + font-mono for a very different context — entering
              structured technical strings in a modal — which doesn't apply
              to chat prose). `rounded-2xl` matches the message bubbles'
              OWN established radius on this same surface. The button reuses
              the original send button's exact fill/hover/disabled tokens
              (`bg-[var(--brand-accent)]`, `text-black`, `hover:opacity-90`,
              `disabled:opacity-50`) — circular + inline is the one
              deliberate, ChatGPT/Claude-directed change from that original. */}
          <div className="relative flex items-end rounded-2xl border border-[var(--gray-05)] bg-[var(--gray-02)] py-2 pl-3.5 pr-12 transition-colors focus-within:border-[var(--gray-08)]">
            <textarea
              ref={textareaRef}
              aria-label="Message Jace"
              rows={1}
              placeholder="Message Jace…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleComposerKeyDown}
              disabled={sending}
              className="max-h-40 w-full resize-none bg-transparent py-1 text-sm text-[var(--gray-12)] outline-none placeholder:text-[var(--gray-08)]"
            />
            <button
              type="submit"
              aria-label="Send message"
              disabled={sending || !input.trim()}
              className="absolute right-1.5 bottom-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--brand-accent)] text-black transition-all duration-150 ease-out hover:opacity-90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ArrowUp size={16} strokeWidth={2.5} />
            </button>
          </div>
        </form>
        {error && <p className="mx-auto mt-2 max-w-[720px] text-xs text-[var(--red-11)]">{error}</p>}
      </div>
    </div>
  );
}

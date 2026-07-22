"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { mergeChatMessages, highestSeq, type ChatMessage, type ChatApproval } from "./chat-helpers";

// Gentle enough not to hammer the poll endpoint, fast enough that Jace's
// reply shows up without a manual refresh — same order of magnitude as the
// onboarding wizard's own poll (4s) and the runs-detail timeline's (5s).
const POLL_INTERVAL_MS = 3000;

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

export function ChatThread({ workspaceId }: { workspaceId: string }) {
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
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/v1/workspaces/${workspaceId}/chat?after_seq=${afterSeqRef.current}`
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
  }, [workspaceId]);

  useEffect(() => {
    mountedRef.current = true;
    poll();
    timerRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [poll]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, approvals.length]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setSending(false);
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
    <div className="flex h-[calc(100vh-160px)] flex-col rounded border border-[var(--gray-05)] bg-[var(--gray-01)]">
      <div className="flex-1 overflow-y-auto p-4">
        {!loaded ? (
          <div className="flex flex-col gap-2.5">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-12 w-2/3 animate-pulse rounded border border-[var(--gray-05)] bg-[var(--gray-02)]"
              />
            ))}
          </div>
        ) : messages.length === 0 && approvals.length === 0 ? (
          <p className="text-xs text-[var(--gray-09)]">
            Say hi — Jace is listening. Ask it to check on a run, kick off work, or just say
            hello.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="flex justify-end">
                  <p className="max-w-[85%] rounded-2xl rounded-tr-sm bg-[var(--gray-05)] px-4 py-2.5 text-xs text-[var(--gray-12)] whitespace-pre-wrap">
                    {m.text}
                  </p>
                </div>
              ) : (
                <div key={m.id} className="flex flex-col gap-1">
                  <span className="flex items-center gap-1.5 px-1 text-xs text-[var(--gray-09)]">
                    <Image src="/jace.png" alt="" width={16} height={16} className="rounded-full" />
                    Jace
                  </span>
                  <div className="w-fit max-w-[92%] rounded-2xl rounded-tl-sm border border-[var(--gray-05)] bg-[var(--gray-00)] px-4 py-3 text-xs text-[var(--gray-12)] whitespace-pre-wrap sm:max-w-[80%]">
                    {m.text}
                  </div>
                </div>
              )
            )}

            {approvals.map((a) => (
              <div
                key={a.id}
                className="flex w-fit max-w-[92%] flex-col gap-2 rounded-2xl rounded-tl-sm border border-[var(--gray-05)] bg-[var(--gray-00)] px-4 py-3 sm:max-w-[80%]"
              >
                <div className="flex items-center gap-2">
                  <span className="inline-flex shrink-0 items-center rounded-sm border border-[var(--gray-06)] bg-[var(--gray-03)] px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide text-[var(--gray-10)]">
                    {toolLabel(a.tool_name)}
                  </span>
                  <span className="text-xs text-[var(--gray-12)]">
                    {summarizeToolInput(a.tool_input)}
                  </span>
                </div>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => decide(a.id, "denied")}
                    disabled={decidingId === a.id}
                    className="h-7 rounded border border-[var(--gray-06)] bg-[var(--gray-03)] px-2.5 text-xs text-[var(--red-11)] transition-colors hover:border-[var(--red-09)]/50 disabled:opacity-50"
                  >
                    Deny
                  </button>
                  <button
                    type="button"
                    onClick={() => decide(a.id, "approved")}
                    disabled={decidingId === a.id}
                    className="h-7 rounded bg-[var(--green-09)] px-2.5 text-xs font-bold text-white transition-colors hover:bg-[var(--green-11)] disabled:opacity-50"
                  >
                    {decidingId === a.id ? "Working…" : "Approve"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={handleSend}
        className="flex items-center gap-2 border-t border-[var(--gray-05)] p-3"
      >
        <input
          aria-label="Message Jace"
          type="text"
          placeholder="Message Jace…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={sending}
          className="h-9 flex-1 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-3 text-xs text-[var(--gray-12)] outline-none placeholder:text-[var(--gray-07)] focus:border-[var(--gray-08)]"
        />
        <button
          type="submit"
          disabled={sending || !input.trim()}
          className="h-9 shrink-0 rounded bg-[var(--brand-accent)] px-3.5 text-xs font-bold text-black transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </form>
      {error && (
        <p className="border-t border-[var(--gray-05)] px-3 py-2 text-xs text-[var(--red-11)]">
          {error}
        </p>
      )}
    </div>
  );
}

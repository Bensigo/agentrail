"use client";

import { useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { runnerStepMode } from "./runner-step-helpers";

export function RunnerStep({
  connected,
  selfHosted,
}: {
  connected: boolean;
  selfHosted: boolean;
}) {
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);
  // Hidden by default (#1281 AC1) — hosted-default mode (every fresh
  // workspace) never shows the install form unless explicitly opened here.
  const [selfHostOpen, setSelfHostOpen] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/auth/device/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_code: trimmed }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setApproved(true);
      setCode("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to authorize the runner");
    } finally {
      setSubmitting(false);
    }
  }

  // The device-code form itself — unchanged from before #1281, just no
  // longer greeted every fresh workspace unconditionally. Rendered either
  // directly (no-execution-path) or behind the self-host disclosure below
  // (hosted-default).
  const deviceCodeForm = (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-relaxed text-[var(--gray-09)]">
        {connected
          ? "Prefer to run on your own machine instead? Sign it in:"
          : "On the machine you want to run your code, sign it in:"}
      </p>
      <code className="w-fit rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-2 py-1 font-mono text-xs text-[var(--gray-12)]">
        agentrail login
      </code>
      <p className="text-xs leading-relaxed text-[var(--gray-09)]">
        It will print a short code. Enter it below to attach that machine as
        this workspace&apos;s runner.
      </p>

      {approved ? (
        <p className="flex items-center gap-1.5 text-xs text-[var(--gray-10)]">
          <Loader2 size={13} className="animate-spin text-[var(--gray-09)]" />
          Authorized — waiting for the runner to connect…
        </p>
      ) : (
        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            aria-label="Device code"
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="WDJB-MJHT"
            autoComplete="off"
            spellCheck={false}
            className="h-8 flex-1 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-2 font-mono text-xs tracking-widest text-[var(--gray-12)] placeholder:text-[var(--gray-08)] outline-none focus:border-[var(--gray-08)]"
          />
          <button
            type="submit"
            disabled={submitting || !code.trim()}
            className="h-8 shrink-0 rounded bg-[var(--brand-accent)] px-3 text-xs font-medium text-black transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Authorizing…" : "Authorize"}
          </button>
        </form>
      )}
      {error && <p className="text-xs text-[var(--red-11)]">{error}</p>}
    </div>
  );

  const mode = runnerStepMode(connected, selfHosted);

  if (mode === "self-hosted-connected") {
    return (
      <p className="flex items-center gap-1.5 text-xs text-[var(--gray-10)]">
        <CheckCircle2 size={13} className="text-[var(--green-11)]" />
        A self-hosted runner is connected and polling for work.
      </p>
    );
  }

  if (mode === "hosted-default") {
    // hostedExecution covers this workspace with no self-hosted runner
    // attached (#1268) — say so honestly rather than implying "a runner" is
    // what's actually polling. The form below is real self-host wiring, not
    // dead code — it just no longer greets a fresh workspace unconditionally
    // (#1281 AC1: never see an install form without asking for it).
    return (
      <div className="flex flex-col gap-2.5">
        <p className="flex items-center gap-1.5 text-xs text-[var(--gray-10)]">
          <CheckCircle2 size={13} className="text-[var(--green-11)]" />
          Done — hosted execution is on. AgentRail&apos;s managed fleet runs
          your work here, no runner required.
        </p>
        <button
          type="button"
          onClick={() => setSelfHostOpen((v) => !v)}
          aria-expanded={selfHostOpen}
          className="flex w-fit items-center gap-1 text-xs text-[var(--blue-11)] hover:underline"
        >
          {selfHostOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          Self-hosting? Attach your own runner
        </button>
        {selfHostOpen && deviceCodeForm}
      </div>
    );
  }

  // mode === "no-execution-path": no hosted execution and no self-hosted
  // runner — nothing is "done" to collapse behind a disclosure, so the form
  // renders directly. Unreachable for a fresh workspace today
  // (hostedExecution defaults true); reachable only if hosted execution is
  // explicitly disabled before a runner is attached.
  return deviceCodeForm;
}

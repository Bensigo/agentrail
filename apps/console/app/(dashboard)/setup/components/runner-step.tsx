"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckCircle2, ChevronDown, ChevronRight } from "lucide-react";
import { runnerStepMode } from "./runner-step-helpers";

export function RunnerStep({
  connected,
  selfHosted,
}: {
  connected: boolean;
  selfHosted: boolean;
}) {
  // Hidden by default (#1281 AC1) — hosted-default mode (every fresh
  // workspace) never shows self-host instructions unless explicitly opened
  // here.
  const [selfHostOpen, setSelfHostOpen] = useState(false);

  // Self-hosting no longer has an in-console credential surface (owner
  // ruling, 2026-07-19: "we don't need to authenticate the cli again... now
  // we have jace"). The embedded device-code form (unchanged since before
  // #1281) duplicated /activate's ActivateForm exactly, so it's gone along
  // with the API Keys page — self-hosters run `agentrail login`, which opens
  // the browser half of the same device flow at /activate, and the docs
  // page below covers the rest. The api_keys table and every /api/v1 route
  // that reads it (runner bearer auth, fleet tokens, /api/v1/auth/device/*)
  // are untouched — this is a UI-only removal.
  const selfHostNotice = (
    <div className="flex flex-col gap-2">
      <p className="text-xs leading-relaxed text-[var(--gray-09)]">
        Run <code className="font-mono text-xs text-[var(--gray-12)]">agentrail login</code> on
        the machine you want to run your code — it walks you through
        attaching that machine as this workspace&apos;s runner.
      </p>
      <Link
        href="/docs/getting-started/self-hosting"
        className="w-fit text-xs text-[var(--blue-11)] hover:underline"
      >
        Self-hosting docs
      </Link>
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
    // what's actually polling.
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
        {selfHostOpen && selfHostNotice}
      </div>
    );
  }

  // mode === "no-execution-path": no hosted execution and no self-hosted
  // runner — nothing is "done" to collapse behind a disclosure, so the
  // notice renders directly. Unreachable for a fresh workspace today
  // (hostedExecution defaults true); reachable only if hosted execution is
  // explicitly disabled before a runner is attached.
  return selfHostNotice;
}

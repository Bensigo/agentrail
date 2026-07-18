"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ONBOARDING_STEP_LABELS,
  ONBOARDING_STEP_ORDER,
  onboardingProgress,
  type OnboardingStep,
} from "../../../../lib/onboarding-steps";
import { StepCard } from "./step-card";
import { GithubStep } from "./github-step";
import { ChannelStep } from "./channel-step";
import { InviteStep } from "./invite-step";
import { RunnerStep } from "./runner-step";

interface OnboardingData {
  steps: OnboardingStep[];
  github: { repoCount: number; repos: string[]; hasWebhookSecret: boolean };
  channel: { connected: boolean; skipped: boolean; chatId: string | null };
  invites: { count: number };
  runner: { connected: boolean; selfHosted: boolean };
}

// Poll cadence while the wizard is open — fast enough that the runner step
// flips to "connected" without a manual refresh (AC3), gentle enough not to
// hammer the read endpoint.
const POLL_INTERVAL_MS = 4000;

export function OnboardingWizard({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<OnboardingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const fetchOnce = useCallback(async (): Promise<OnboardingData | null> => {
    try {
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/onboarding`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as OnboardingData;
      if (mountedRef.current) {
        setData(json);
        setError(null);
      }
      return json;
    } catch (e) {
      if (mountedRef.current) {
        setError(e instanceof Error ? e.message : "Failed to load setup status");
      }
      return null;
    }
  }, [workspaceId]);

  // Self-rescheduling: fetch once, and — only while some step is still
  // incomplete — queue the next fetch. A finished wizard stops polling
  // instead of ticking forever in an idle tab.
  const schedule = useCallback(
    (delay: number) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(async () => {
        const json = await fetchOnce();
        if (json && mountedRef.current && !onboardingProgress(json.steps).allDone) {
          schedule(POLL_INTERVAL_MS);
        }
      }, delay);
    },
    [fetchOnce]
  );

  /** Refetch immediately (e.g. after a child step mutates something), then
   * resume polling if the wizard isn't finished yet. */
  const refresh = useCallback(async () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const json = await fetchOnce();
    if (json && !onboardingProgress(json.steps).allDone) {
      schedule(POLL_INTERVAL_MS);
    }
  }, [fetchOnce, schedule]);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // Intentionally only re-run on workspaceId change — `refresh` is stable
    // in practice (its deps are workspaceId-derived) and re-running this
    // effect on every render would restart polling from scratch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  if (error) {
    return (
      <div className="rounded border border-[var(--red-09)]/30 bg-[var(--red-09)]/10 px-4 py-3">
        <p className="text-xs text-[var(--red-11)]">{error}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col gap-2.5">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-14 animate-pulse rounded border border-[var(--gray-05)] bg-[var(--gray-01)]"
          />
        ))}
      </div>
    );
  }

  const progress = onboardingProgress(data.steps);
  // Open the first not-yet-resolved step by default; everything else stays
  // collapsed so a returning user isn't re-shown steps they already finished.
  const firstIncompleteId = data.steps.find((s) => s.status === "incomplete")?.id;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between text-xs text-[var(--gray-09)]">
        <span>
          {progress.done} of {progress.total} steps done
        </span>
      </div>

      <div className="flex flex-col gap-2.5">
        {ONBOARDING_STEP_ORDER.map((id, i) => {
          const step = data.steps.find((s) => s.id === id)!;
          return (
            <StepCard
              key={id}
              index={i + 1}
              title={ONBOARDING_STEP_LABELS[id]}
              status={step.status}
              defaultOpen={id === (firstIncompleteId ?? ONBOARDING_STEP_ORDER[0])}
            >
              {id === "connect-github" && (
                <GithubStep
                  workspaceId={workspaceId}
                  repos={data.github.repos}
                  hasWebhookSecret={data.github.hasWebhookSecret}
                  onChanged={refresh}
                />
              )}
              {id === "connect-channel" && (
                <ChannelStep
                  workspaceId={workspaceId}
                  connected={data.channel.connected}
                  skipped={data.channel.skipped}
                  chatId={data.channel.chatId}
                  onChanged={refresh}
                />
              )}
              {id === "invite-team" && (
                <InviteStep
                  workspaceId={workspaceId}
                  teammateCount={data.invites.count}
                  onChanged={refresh}
                />
              )}
              {id === "attach-runner" && (
                <RunnerStep
                  connected={data.runner.connected}
                  selfHosted={data.runner.selfHosted}
                />
              )}
            </StepCard>
          );
        })}
      </div>

      <Link
        href={`/dashboard/${workspaceId}`}
        className="self-start text-xs text-[var(--blue-11)] hover:underline"
      >
        Continue to dashboard →
      </Link>
    </div>
  );
}

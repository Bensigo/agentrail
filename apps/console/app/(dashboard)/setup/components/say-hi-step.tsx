"use client";

import Link from "next/link";
import { CheckCircle2 } from "lucide-react";

/**
 * The "Say hi to Jace" onboarding step (#1288 AC3) — completion is derived
 * server-side from `hasAnyJaceReply` (a real `jace_messages` reply exists),
 * never tracked here; this component only renders the three states
 * `deriveOnboardingSteps` can produce for `say-hi-to-jace`.
 */
export function SayHiStep({
  workspaceId,
  enabled,
  jaceReplied,
}: {
  workspaceId: string;
  enabled: boolean;
  jaceReplied: boolean;
}) {
  if (jaceReplied) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-[var(--gray-10)]">
        <CheckCircle2 size={13} className="text-[var(--green-11)]" />
        Jace replied — you&apos;re talking.
      </p>
    );
  }

  if (!enabled) {
    return (
      <p className="text-xs leading-relaxed text-[var(--gray-09)]">
        Console chat isn&apos;t enabled for this workspace yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-xs leading-relaxed text-[var(--gray-09)]">
        Send Jace a message right from the dashboard — no setup needed.
      </p>
      <Link
        href={`/dashboard/${workspaceId}/chat`}
        className="flex h-8 w-full items-center justify-center rounded bg-[var(--brand-accent)] px-3 text-xs font-bold text-black transition-colors hover:opacity-90"
      >
        Open chat
      </Link>
    </div>
  );
}

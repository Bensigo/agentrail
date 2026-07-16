import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { loadOnboardingData } from "../../../../../lib/onboarding-data";
import {
  onboardingProgress,
  shouldShowOnboardingBanner,
} from "../../../../../lib/onboarding-steps";

/**
 * Home progress banner (#1233, spec §5): "Incomplete steps show as a
 * progress banner on Home linking back to the wizard." Server component —
 * derives from the same pure function's inputs as the `/setup` wizard
 * (`onboarding-data.ts` does the I/O, `onboarding-steps.ts` the derivation;
 * `shouldShowOnboardingBanner`/`onboardingProgress` are unit-tested on their
 * own). Renders nothing once every step is complete or skipped (AC4).
 */
export async function OnboardingBanner({ workspaceId }: { workspaceId: string }) {
  const data = await loadOnboardingData(workspaceId);
  if (!shouldShowOnboardingBanner(data.steps)) return null;

  const progress = onboardingProgress(data.steps);

  return (
    <Link
      href={`/setup?workspace=${workspaceId}`}
      className="flex items-center justify-between gap-3 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-4 py-2.5 transition-colors hover:border-[var(--gray-08)]"
    >
      <span className="text-sm text-[var(--gray-12)]">
        Finish setting up — {progress.done} of {progress.total} steps done
      </span>
      <span className="flex shrink-0 items-center gap-0.5 text-xs text-[var(--blue-11)]">
        Continue setup <ArrowUpRight className="h-3 w-3" />
      </span>
    </Link>
  );
}

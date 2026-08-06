/** Illustrative copy for the landing page's contract-confirmation demo. */
export const DEMO_USER_MESSAGE =
  "Add safe webhook retries?";

export const DEMO_CONTRACT = {
  title: "Webhook retry plan",
  goal: "Retry failed webhooks safely.",
  acceptanceCriteria: [
    "Try up to 3 times with backoff.",
    "Stop when a retry succeeds.",
    "Show retries that still fail.",
  ],
} as const;

export function getDemoFollowUpMessage(): string {
  return "Confirmed. I’ll prepare the context for your coding agent.";
}

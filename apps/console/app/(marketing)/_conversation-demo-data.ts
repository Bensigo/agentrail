/** Illustrative copy for the landing page's contract-confirmation demo. */
export const DEMO_USER_MESSAGE =
  "Webhook deliveries are dropping silently on a transient 5xx. Can you add a retry with backoff?";

export const DEMO_CONTRACT = {
  title: "Retry webhook delivery with backoff",
  goal: "Make transient 5xx webhook failures retry safely before a delivery is marked failed.",
  boundary: "Jace defines the acceptance contract; the selected external builder implements it.",
  acceptanceCriteria: [
    "Retry a failed delivery up to 3 times with exponential backoff.",
    "Mark the delivery complete when any retry succeeds.",
    "Show exhausted retries in the failures view with each attempt logged.",
  ],
  builder: "external builder",
} as const;

export function getDemoFollowUpMessage(): string {
  return `Jace prepares a bounded Context Pack for the selected ${DEMO_CONTRACT.builder}.`;
}

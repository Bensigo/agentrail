export const RELEASE_CHECK_NAME = "agentrail:release-verification";

export interface DeliveryStart {
  kind: "feature" | "fix" | "pr";
  endpoint: "review" | "release";
  brief: string;
  prUrl?: string;
}

export type DeliveryCheckpoint =
  | { step: "ready"; criteria: string[]; planPath?: string; issueUrl?: string }
  | { step: "review"; headSha: string }
  | { step: "rework" }
  | { step: "ship" }
  | { step: "follow_up"; issueUrl?: string }
  | { step: "release"; commitSha: string; targetUrl: string };

export interface DeliveryState extends Omit<DeliveryStart, "prUrl"> {
  stage: "shaping" | "building" | "review" | "releasing" | "verified";
  criteria?: string[];
  planPath?: string;
  issueUrl?: string;
  reviewHead?: string;
  followUpIssueUrl?: string;
  release?: {
    commitSha: string;
    targetUrl: string;
    url?: string;
    verifiedAt?: string;
  };
}

export const isCommit = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value);

export function releaseUrlValid(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512 || /\s/.test(value))
    return false;
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}

export function startDelivery(input: DeliveryStart): DeliveryState {
  const { kind, endpoint, brief } = input;
  return {
    kind,
    endpoint,
    brief,
    stage:
      kind === "feature" ? "shaping" : kind === "pr" ? "review" : "building",
  };
}

export function reworkDelivery(state: DeliveryState): DeliveryState {
  const {
    reviewHead: _reviewHead,
    release: _release,
    followUpIssueUrl: _followUpIssue,
    ...plan
  } = state;
  return {
    ...plan,
    stage: state.kind === "feature" && !state.criteria ? "shaping" : "building",
  };
}

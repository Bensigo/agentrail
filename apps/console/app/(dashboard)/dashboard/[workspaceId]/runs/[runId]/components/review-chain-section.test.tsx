import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReviewChainContent } from "./review-chain-section";

const resolved = {
  run: {
    queueEntryId: "queue-entry-1234",
    prUrl: "https://github.com/acme/repo/pull/42",
    prHeadSha: "a".repeat(40),
  },
  prResolution: { state: "resolved" as const, repo: "acme/repo", number: 42 },
  evidenceResolution: { state: "head_bound" as const, headSha: "a".repeat(40) },
  reviewJobs: [
    {
      id: "job-1",
      state: "posted",
      verdict: "approve",
      postedReviewUrl: "https://github.com/acme/repo/pull/42#pullrequestreview-1",
      createdAt: "2026-08-04T10:00:00.000Z",
    },
  ],
  reviewEvents: [
    {
      id: "event-1",
      eventType: "human_review_time",
      occurredAt: "2026-08-04T10:02:00.000Z",
      reviewState: "approved",
      humanReviewMinutes: 12,
      humanReviewSource: "timer" as const,
    },
    {
      id: "event-2",
      eventType: "merged",
      occurredAt: "2026-08-04T10:05:00.000Z",
      reviewState: null,
      humanReviewMinutes: null,
      humanReviewSource: null,
    },
  ],
};

describe("ReviewChainContent", () => {
  it("renders only recorded review and outcome evidence for a resolved PR", () => {
    const html = renderToStaticMarkup(<ReviewChainContent data={resolved} />);

    expect(html).toContain("acme/repo #42");
    expect(html).toContain("Queue entry queue-en");
    expect(html).toContain("Published head aaaaaaaaaaaa");
    expect(html).toContain("Human review time: 12 min");
    expect(html).toContain("Reviewer of record");
    expect(html).toContain("approve");
    expect(html).toContain("Open posted review");
    expect(html).toContain("human review time");
    expect(html).toContain("merged");
  });

  it("states the absence of a PR instead of inferring an outcome", () => {
    const html = renderToStaticMarkup(
      <ReviewChainContent
        data={{
          ...resolved,
          prResolution: { state: "no_pr", repo: null, number: null },
          reviewJobs: [],
          reviewEvents: [],
        }}
      />
    );

    expect(html).toContain("did not open a pull request");
    expect(html).not.toContain("Outcome evidence");
  });

  it("keeps a non-GitHub PR link explicitly unknown", () => {
    const html = renderToStaticMarkup(
      <ReviewChainContent
        data={{
          ...resolved,
          prResolution: { state: "unknown", repo: null, number: null },
          reviewJobs: [],
          reviewEvents: [],
        }}
      />
    );

    expect(html).toContain("unavailable rather than inferred");
    expect(html).not.toContain("acme/repo #42");
  });

  it("does not borrow PR-wide history when the run head is unknown", () => {
    const html = renderToStaticMarkup(
      <ReviewChainContent
        data={{
          ...resolved,
          run: { ...resolved.run, prHeadSha: null },
          evidenceResolution: { state: "unknown", headSha: null },
          reviewJobs: [],
          reviewEvents: [],
        }}
      />
    );

    expect(html).toContain("no recorded published commit");
    expect(html).toContain("unavailable rather than inferred");
    expect(html).not.toContain("Outcome evidence");
  });
});

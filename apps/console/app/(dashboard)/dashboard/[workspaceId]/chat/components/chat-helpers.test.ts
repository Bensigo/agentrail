import { describe, expect, it } from "vitest";
import { defaultUrlTransform } from "react-markdown";
import {
  GOAL_REFERENCE_HREF_PREFIX,
  mergeChatMessages,
  highestSeq,
  isAwaitingReply,
  parseGithubLink,
  linkifyGoalReferences,
  type ChatMessage,
  type ChatApproval,
} from "./chat-helpers";

function msg(seq: number, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `m-${seq}`,
    seq,
    role: "user",
    text: `message ${seq}`,
    created_at: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
    ...overrides,
  };
}

describe("mergeChatMessages", () => {
  it("appends new messages after existing ones, sorted ascending by seq", () => {
    const existing = [msg(1), msg(2)];
    const incoming = [msg(3), msg(4)];
    expect(mergeChatMessages(existing, incoming).map((m) => m.seq)).toEqual([1, 2, 3, 4]);
  });

  it("de-duplicates by seq — a re-sent message never appears twice", () => {
    const existing = [msg(1), msg(2)];
    const incoming = [msg(2), msg(3)];
    const result = mergeChatMessages(existing, incoming);
    expect(result.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it("a re-sent seq keeps the INCOMING copy (in case content ever legitimately differs)", () => {
    const existing = [msg(1, { text: "stale" })];
    const incoming = [msg(1, { text: "fresh" })];
    expect(mergeChatMessages(existing, incoming)[0]?.text).toBe("fresh");
  });

  it("handles an empty incoming list (no-op poll)", () => {
    const existing = [msg(1), msg(2)];
    expect(mergeChatMessages(existing, [])).toEqual(existing);
  });

  it("handles an empty existing list (first load)", () => {
    const incoming = [msg(1), msg(2)];
    expect(mergeChatMessages([], incoming).map((m) => m.seq)).toEqual([1, 2]);
  });

  it("out-of-order incoming still sorts correctly", () => {
    const result = mergeChatMessages([], [msg(3), msg(1), msg(2)]);
    expect(result.map((m) => m.seq)).toEqual([1, 2, 3]);
  });
});

describe("highestSeq", () => {
  it("returns the max seq across the list", () => {
    expect(highestSeq([msg(1), msg(5), msg(3)])).toBe(5);
  });

  it("returns 0 for an empty list — the fresh-thread cursor", () => {
    expect(highestSeq([])).toBe(0);
  });
});

function approval(id: string): ChatApproval {
  return { id, tool_name: "create_issue", tool_input: {}, created_at: new Date().toISOString() };
}

describe("isAwaitingReply", () => {
  it("false for an empty thread (nothing sent yet)", () => {
    expect(isAwaitingReply([], [])).toBe(false);
  });

  it("true right after the member sends a message and nothing has come back", () => {
    expect(isAwaitingReply([msg(1, { role: "user" })], [])).toBe(true);
  });

  it("false once Jace's reply is the last message", () => {
    expect(isAwaitingReply([msg(1, { role: "user" }), msg(2, { role: "jace" })], [])).toBe(false);
  });

  it("false while a pending approval exists — that IS Jace's response, not silence", () => {
    expect(isAwaitingReply([msg(1, { role: "user" })], [approval("a1")])).toBe(false);
  });

  it("true again after the member sends a NEW message following an earlier jace reply", () => {
    const messages = [msg(1, { role: "user" }), msg(2, { role: "jace" }), msg(3, { role: "user" })];
    expect(isAwaitingReply(messages, [])).toBe(true);
  });
});

describe("parseGithubLink", () => {
  it("recognizes a pull request URL", () => {
    expect(parseGithubLink("https://github.com/bensigo/agentrail/pull/1404")).toEqual({
      kind: "pull",
      owner: "bensigo",
      repo: "agentrail",
      number: "1404",
    });
  });

  it("recognizes an issue URL", () => {
    expect(parseGithubLink("https://github.com/bensigo/agentrail/issues/1288")).toEqual({
      kind: "issue",
      owner: "bensigo",
      repo: "agentrail",
      number: "1288",
    });
  });

  it("recognizes a PR URL with a trailing path/query/fragment", () => {
    expect(parseGithubLink("https://github.com/bensigo/agentrail/pull/1404/files")).toMatchObject({
      kind: "pull",
      number: "1404",
    });
  });

  it("recognizes a file blob URL and derives the filename", () => {
    expect(
      parseGithubLink(
        "https://github.com/bensigo/agentrail/blob/main/apps/console/app/globals.css"
      )
    ).toEqual({
      kind: "file",
      owner: "bensigo",
      repo: "agentrail",
      path: "apps/console/app/globals.css",
      filename: "globals.css",
    });
  });

  it("returns null for a plain github.com URL that isn't a PR/issue/blob", () => {
    expect(parseGithubLink("https://github.com/bensigo/agentrail")).toBeNull();
  });

  it("returns null for a non-github URL", () => {
    expect(parseGithubLink("https://example.com/pull/1")).toBeNull();
  });
});

describe("linkifyGoalReferences", () => {
  it("rewrites a goal stamp into a sentinel markdown link (NOT a goal:// URI scheme — react-markdown's default urlTransform strips unrecognized protocols to '', see GOAL_REFERENCE_HREF_PREFIX's own doc-comment)", () => {
    expect(linkifyGoalReferences("Filed toward Goal: reach 80% coverage (goal:coverage-80).")).toBe(
      "Filed toward Goal: reach 80% coverage [Goal: coverage-80](/__goal_ref__/coverage-80)."
    );
  });

  it("rewrites every stamp when there are multiple", () => {
    const input = "(goal:a) and (goal:b)";
    expect(linkifyGoalReferences(input)).toBe(
      "[Goal: a](/__goal_ref__/a) and [Goal: b](/__goal_ref__/b)"
    );
  });

  it("leaves text with no goal stamp untouched", () => {
    expect(linkifyGoalReferences("just a normal reply")).toBe("just a normal reply");
  });

  it("regression: the produced href survives react-markdown's REAL defaultUrlTransform unchanged (caught live in the browser: a goal:// URI-scheme version got silently stripped to '' by this exact sanitizer, rendering as unlinked plain text)", () => {
    const href = `${GOAL_REFERENCE_HREF_PREFIX}coverage-80`;
    expect(defaultUrlTransform(href)).toBe(href);
  });
});

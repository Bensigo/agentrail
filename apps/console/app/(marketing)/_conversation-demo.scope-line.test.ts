import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scopeSentence } from "../../lib/approval-scope";
import { getDemoBrief } from "./_conversation-demo-data";

// Subscription-platform slice 6 Task 5: the landing demo's alignment-brief
// bubble speaks scope, not dollars — UNCONDITIONALLY (marketing mirrors the
// flag-on product; this plan's own Architecture section: "The landing demo
// changes unconditionally... marketing truth-ups land unconditional").
//
// No render harness exists in this repo (`environment: "node"`, no jsdom/
// @testing-library — see `_conversation-demo.tokens-only.test.ts`'s own
// header comment), and `ConversationDemo` is a stateful "use client"
// component (`useState`), not a hook-free server component, so it can't be
// called directly the way this repo's page/layout tests call THEIR
// components either. Source-text scanning — the same idiom
// `tokens-only.test.ts` already established for this exact file — is what
// this repo's infra actually supports.

function readConversationDemoSource(): string {
  return readFileSync(new URL("./_conversation-demo.tsx", import.meta.url), "utf8");
}

describe("(marketing) conversation demo — scope line, not dollars (subscription slice 6 Task 5)", () => {
  it("renders the alignment-brief line via the shared scopeSentence helper, imported from the single-sourced lib", () => {
    const source = readConversationDemoSource();
    expect(source).toMatch(/import\s*\{\s*scopeSentence\s*\}\s*from\s*["']\.\.\/\.\.\/lib\/approval-scope["']/);
    expect(source).toContain("scopeSentence(brief.estimateUsd)");
  });

  it("no longer renders the pre-Task-5 dollar sanction line (no hand-rolled '~$' copy)", () => {
    const source = readConversationDemoSource();
    expect(source).not.toContain("Approving sets this run");
    expect(source).not.toContain("budget: ~$");
  });

  it("DEMO_TASK_INPUT's real, live-computed brief renders through the real scopeSentence helper — no invented copy, no dollar sign (drift guard, mirrors _conversation-demo-data.test.ts's own pattern)", () => {
    const brief = getDemoBrief();
    const sentence = scopeSentence(brief.estimateUsd);
    expect(sentence).toMatch(/^Approving starts a (small|medium|large) task\.$/);
    expect(sentence).not.toContain("$");
  });
});

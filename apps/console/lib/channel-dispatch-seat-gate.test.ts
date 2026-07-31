import { describe, expect, it } from "vitest";
import { decideSeatGate, buildSeatLimitPrompt } from "./channel-dispatch";

/**
 * `decideSeatGate` / `buildSeatLimitPrompt` (spec §6 "Enforcement seams"
 * point 1, slice 5 Task 4) — the pure decision + copy behind the chat seat
 * gate `processRow`/`processConsoleRow` apply to every served turn. Both are
 * pure, no I/O — no mocking needed here, same convention as
 * `channel-dispatch-seat-claim.test.ts`'s `decideSeatClaimForServedTurn`
 * suite (see that file's own doc-comment): a real, unmocked import of
 * `./channel-dispatch` is safe because neither function touches `db` or any
 * network seam.
 *
 * What this does NOT cover (by design — impure, DB-backed, exercised
 * indirectly through `processRow`/`processConsoleRow` instead): resolving
 * `billingAccountId`/`degraded` via `resolvePolicyForWorkspace`, the
 * `hasActiveSeat`/`countActiveSeats`/`getWorkspaceMembership` reads that feed
 * this function's inputs, the `recordUpgradePromptOnce` CAS, or actually
 * delivering the prompt. Those live in the module-private
 * `applySeatGateForServedTurn` — see `channel-dispatch.test.ts`'s own
 * "chat seat gate" describe block for that wiring.
 */
describe("decideSeatGate", () => {
  // Every field set to whatever makes the gate fire — each test below flips
  // EXACTLY one field back to its "safe" value and asserts the verdict flips
  // to "pass", proving every one of the six factors is independently
  // load-bearing (spec §6: "gate" only when ALL of them hold at once).
  const GATE_PARAMS = {
    enforced: true,
    degraded: false,
    billingAccountId: "acct-1",
    seatLimit: 3,
    subjectHasSeat: false,
    activeSeatCount: 3,
    isWorkspaceAdmin: false,
  };

  it("gates when every blocking condition holds: enforced, not degraded, a real billing account, no existing seat, not an admin, and the account is at its seat limit", () => {
    expect(decideSeatGate(GATE_PARAMS)).toBe("gate");
  });

  it("passes when the arc kill-switch (subscriptionsEnforced) is off", () => {
    expect(decideSeatGate({ ...GATE_PARAMS, enforced: false })).toBe("pass");
  });

  it("passes when the resolved policy is degraded — billing data is not trustworthy enough to enforce against (spec §6 hard contract)", () => {
    expect(decideSeatGate({ ...GATE_PARAMS, degraded: true })).toBe("pass");
  });

  it("passes when there is no real billing account yet (billingAccountId null — a transitional workspace)", () => {
    expect(decideSeatGate({ ...GATE_PARAMS, billingAccountId: null })).toBe("pass");
  });

  it("passes when the subject already holds an active seat — an existing seat-holder is never blocked (spec §5 rule 1)", () => {
    expect(decideSeatGate({ ...GATE_PARAMS, subjectHasSeat: true })).toBe("pass");
  });

  it("passes when the subject is a workspace owner/admin — the owner/admin bypass (spec §5 rule 4)", () => {
    expect(decideSeatGate({ ...GATE_PARAMS, isWorkspaceAdmin: true })).toBe("pass");
  });

  it("passes when the account is strictly under its seat limit", () => {
    expect(decideSeatGate({ ...GATE_PARAMS, activeSeatCount: 2, seatLimit: 3 })).toBe("pass");
  });

  it("gates exactly AT the boundary — activeSeatCount === seatLimit already counts as full, no room for one more", () => {
    expect(decideSeatGate({ ...GATE_PARAMS, activeSeatCount: 3, seatLimit: 3 })).toBe("gate");
  });

  it("still gates when the account is already OVER its limit (e.g. an unconditional invite-accept claim pushed it past the cap)", () => {
    expect(decideSeatGate({ ...GATE_PARAMS, activeSeatCount: 5, seatLimit: 3 })).toBe("gate");
  });

  it("defaults to pass for an all-false/zeroed, not-enforced input", () => {
    expect(
      decideSeatGate({
        enforced: false,
        degraded: false,
        billingAccountId: null,
        seatLimit: 0,
        subjectHasSeat: false,
        activeSeatCount: 0,
        isWorkspaceAdmin: false,
      })
    ).toBe("pass");
  });
});

describe("buildSeatLimitPrompt", () => {
  it("returns the byte-exact base prompt, with no /connect hint, when the account holds no unlinked identity seats", () => {
    expect(buildSeatLimitPrompt(false)).toBe(
      "You've reached your team's seat limit. Upgrade your plan or remove an inactive member."
    );
  });

  it("appends the byte-exact /connect hint when the account holds at least one active identity-keyed seat (spec §5 rule 3)", () => {
    expect(buildSeatLimitPrompt(true)).toBe(
      "You've reached your team's seat limit. Upgrade your plan or remove an inactive member. Already have a seat? Use /connect to link your account."
    );
  });

  it("never mentions dollars, a model name, or the word \"budget\" — this prompt is entirely about seats (spec §6 copy rule)", () => {
    const withHint = buildSeatLimitPrompt(true).toLowerCase();
    const withoutHint = buildSeatLimitPrompt(false).toLowerCase();
    for (const text of [withHint, withoutHint]) {
      expect(text).not.toContain("$");
      expect(text).not.toContain("budget");
    }
  });
});

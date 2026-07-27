import { describe, it, expect } from "vitest";
import { parseConnectCommand, decideConnectCommand } from "./connect-command";

describe("parseConnectCommand", () => {
  const matches: Array<[string, string]> = [
    ["/connect", ""],
    ["  /connect  ", ""],
    ["/CONNECT", ""],
    ["/connect@jace_bot", ""],
    ["<@123456789> /connect", ""],
    ["<@!123456789> /connect", ""],
    ["/connect agentrail-dev", "agentrail-dev"],
    ["/connect@jace_bot agentrail-dev", "agentrail-dev"],
    ["<@123456789> /connect  agentrail dev  ", "agentrail dev"],
  ];
  for (const [input, arg] of matches) {
    it(`matches ${JSON.stringify(input)}`, () => {
      expect(parseConnectCommand(input)).toEqual({ isCommand: true, arg });
    });
  }

  const nonMatches = [
    "",
    "   ",
    "connect",
    "/connected",
    "/connect-me",
    "please /connect me",
    "i want you to /connect",
    "//connect",
  ];
  for (const input of nonMatches) {
    it(`does not match ${JSON.stringify(input)}`, () => {
      expect(parseConnectCommand(input)).toEqual({ isCommand: false, arg: "" });
    });
  }
});

const WS_A = { id: "ws-a", name: "agentrail-dev" };
const WS_B = { id: "ws-b", name: "side-project" };

describe("decideConnectCommand", () => {
  const linked = { userId: "user-1" };
  const unlinked = { userId: null };

  it("unlinked identity gets a link, arg ignored", () => {
    expect(
      decideConnectCommand({ arg: "agentrail-dev", identity: unlinked, pinned: null, reachable: [WS_A] })
    ).toEqual({ kind: "send_link" });
  });

  it("linked with no reachable workspaces", () => {
    expect(
      decideConnectCommand({ arg: "", identity: linked, pinned: null, reachable: [] })
    ).toEqual({ kind: "no_workspaces" });
  });

  it("linked, one reachable, unpinned, bare -> pin it", () => {
    expect(
      decideConnectCommand({ arg: "", identity: linked, pinned: null, reachable: [WS_A] })
    ).toEqual({ kind: "pin", workspace: WS_A });
  });

  it("linked, two reachable, unpinned, bare -> choose", () => {
    expect(
      decideConnectCommand({ arg: "", identity: linked, pinned: null, reachable: [WS_A, WS_B] })
    ).toEqual({ kind: "choose", options: [WS_A, WS_B] });
  });

  it("named match is case-insensitive", () => {
    expect(
      decideConnectCommand({ arg: "AGENTRAIL-DEV", identity: linked, pinned: null, reachable: [WS_A, WS_B] })
    ).toEqual({ kind: "pin", workspace: WS_A });
  });

  it("unknown name re-renders the list", () => {
    expect(
      decideConnectCommand({ arg: "nope", identity: linked, pinned: null, reachable: [WS_A, WS_B] })
    ).toEqual({ kind: "unknown_workspace", options: [WS_A, WS_B] });
  });

  it("ambiguous name re-renders rather than guessing", () => {
    const dupe = { id: "ws-c", name: "agentrail-dev" };
    expect(
      decideConnectCommand({ arg: "agentrail-dev", identity: linked, pinned: null, reachable: [WS_A, dupe] })
    ).toEqual({ kind: "unknown_workspace", options: [WS_A, dupe] });
  });

  it("already pinned, bare -> status with alternatives excluding current", () => {
    expect(
      decideConnectCommand({ arg: "", identity: linked, pinned: WS_A, reachable: [WS_A, WS_B] })
    ).toEqual({ kind: "already_pinned", workspace: WS_A, alternatives: [WS_B] });
  });

  it("re-pin to the workspace already pinned is a no-op status", () => {
    expect(
      decideConnectCommand({ arg: "agentrail-dev", identity: linked, pinned: WS_A, reachable: [WS_A, WS_B] })
    ).toEqual({ kind: "already_pinned", workspace: WS_A, alternatives: [WS_B] });
  });

  it("re-pin allowed when the requester reaches BOTH", () => {
    expect(
      decideConnectCommand({ arg: "side-project", identity: linked, pinned: WS_A, reachable: [WS_A, WS_B] })
    ).toEqual({ kind: "repin", from: WS_A, to: WS_B });
  });

  it("re-pin REFUSED when the requester cannot reach the current pin", () => {
    // pinned to a workspace this identity is a stranger to: name is unknown.
    expect(
      decideConnectCommand({
        arg: "side-project",
        identity: linked,
        pinned: { id: "ws-foreign", name: null },
        reachable: [WS_B],
      })
    ).toEqual({ kind: "repin_refused" });
  });

  it("refusal carries no identifying detail", () => {
    const action = decideConnectCommand({
      arg: "side-project",
      identity: linked,
      pinned: { id: "ws-foreign", name: null },
      reachable: [WS_B],
    });
    expect(JSON.stringify(action)).not.toContain("ws-foreign");
  });

  it("bare /connect on an unreachable pin does not leak the workspace", () => {
    const action = decideConnectCommand({
      arg: "",
      identity: { userId: "user-1" },
      pinned: { id: "ws-foreign", name: null },
      reachable: [WS_B],
    });
    expect(action).toEqual({ kind: "already_pinned", workspace: null, alternatives: [WS_B] });
    expect(JSON.stringify(action)).not.toContain("ws-foreign");
  });

  it("whitespace-only arg behaves identically to the bare command", () => {
    expect(
      decideConnectCommand({ arg: "   ", identity: linked, pinned: null, reachable: [WS_A, WS_B] })
    ).toEqual({ kind: "choose", options: [WS_A, WS_B] });
  });
});

import { describe, it, expect } from "vitest";
import { parseConnectCommand } from "./connect-command";

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

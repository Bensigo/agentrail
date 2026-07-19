import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Console tokens only, no raw hex (controller ruling, #1279 PR ①). Scoped to
// a Tailwind ARBITRARY-VALUE hex pattern (`bg-[#...]`, `text-[#...]`,
// `border-[#...]`, `fill-[#...]`, `style={{ ...: "#..." }}`) rather than a
// bare `#[0-9a-fA-F]{3,8}` sweep — a naive sweep false-positives on this
// file's own GitHub issue references (`#1279`, `#888` — decimal digits are
// valid hex digits too; see the wave-4 recon annex §5's exact same lesson).
// This targets the real failure mode: a hardcoded color used instead of a
// `var(--token)` custom property.
//
// Deliberately NOT global (`g`): this same regex object is reused across
// several `toMatch`/`.match()` calls below, and a global regex's `lastIndex`
// persists between calls — a classic shared-instance footgun that can make a
// later assertion silently start scanning mid-string. Existence checks don't
// need `g` at all.
const HEX_COLOR_USAGE = /(?:-\[#[0-9a-fA-F]{3,8}\])|(?:"#[0-9a-fA-F]{3,8}")/;

function readSibling(filename: string): string {
  return readFileSync(new URL(filename, import.meta.url), "utf8");
}

describe("(marketing) conversation demo — tokens only", () => {
  it("_conversation-demo.tsx has zero hardcoded hex color usage", () => {
    const source = readSibling("./_conversation-demo.tsx");
    expect(source.match(HEX_COLOR_USAGE)).toBeNull();
  });

  it("_conversation-demo.tsx has no inline style prop at all (className + tokens only)", () => {
    const source = readSibling("./_conversation-demo.tsx");
    expect(source).not.toMatch(/style=\{/);
  });
});

// Self-check: prove the regex actually catches the failure mode it exists to
// catch, and does NOT false-positive on an issue-number reference — so a
// change to the pattern above that quietly stops matching real hex (or
// starts flagging "#1279") fails loudly here, not just in the two tests above.
describe("HEX_COLOR_USAGE pattern sanity", () => {
  it("matches a Tailwind arbitrary hex value", () => {
    expect('className="bg-[#1a3d33]"').toMatch(HEX_COLOR_USAGE);
  });

  it("matches a hardcoded hex string in an inline style object", () => {
    expect('style={{ color: "#ffe629" }}').toMatch(HEX_COLOR_USAGE);
  });

  it("does NOT match a bare GitHub issue reference in prose", () => {
    expect("fixed in #1279, see also #888").not.toMatch(HEX_COLOR_USAGE);
  });
});

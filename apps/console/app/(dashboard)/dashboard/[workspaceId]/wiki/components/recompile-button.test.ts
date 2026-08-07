import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./recompile-button.tsx", import.meta.url)),
  "utf8"
);

describe("recompile button user-visible copy", () => {
  it("uses neutral recompilation wording", () => {
    expect(source).toContain("Queued — the repository wiki will be recompiled shortly");
    expect(source).not.toContain("Jace&apos;s factory will recompile shortly");
  });
});

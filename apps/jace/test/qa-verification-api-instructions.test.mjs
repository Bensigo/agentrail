import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const path = fileURLToPath(new URL("../agent/subagents/qa/instructions.md", import.meta.url));
const prose = readFileSync(path, "utf8");

test("QA exact-head API execution is bounded to a descriptor and redacted artifact", () => {
  for (const value of ["Acceptance Record API execution", "immutable `GET` path", "do not follow redirects", "credentials", "upload_verification_api_artifact", "not_testable", "not_proven", "never a pass by itself"]) assert.ok(prose.includes(value), `missing ${value}`);
});

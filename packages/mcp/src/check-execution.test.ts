import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { executeCheck } from "./check-execution.js";
describe("configured check execution", () => {
  it("retains actual pass/fail exit status", async () => {
    expect(await executeCheck([process.execPath, "-e", "process.exit(7)"], process.cwd(), process.env)).toMatchObject({ exitCode: 7 });
    expect(await executeCheck([process.execPath, "-e", "console.log('ok')"], process.cwd(), process.env)).toMatchObject({ exitCode: 0, output: "ok\n" });
  });
  it("bounds output and stops descendants at the deadline", async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "agentrail-check-"));
    const processCode = `const {spawn}=require('child_process');const {writeFileSync}=require('fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'ignore'});writeFileSync('pid',String(c.pid));setInterval(()=>{},100)`;
    expect((await executeCheck([process.execPath, "-e", processCode], dir, process.env, 2000)).exitCode).toBe(1);
    const pid = Number(await readFile(resolve(dir, "pid"), "utf8"));
    await new Promise(r => setTimeout(r, 100));
    expect(() => process.kill(pid, 0)).toThrow();
    expect((await executeCheck([process.execPath, "-e", "console.log('x'.repeat(300000))"], dir, process.env)).exitCode).toBe(1);
  }, 15000);
});

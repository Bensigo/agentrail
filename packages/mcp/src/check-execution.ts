import { spawn, execFile } from "node:child_process";

/** Bound a check's output and entire process group, including npm workers. */
export function executeCheck(command: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 120000): Promise<{ exitCode: number; output: string }> {
  return new Promise(resolve => {
    const child = spawn(command[0], command.slice(1), { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let bytes = 0; let forced = false; let done = false;
    const cleanup = () => {
      if (!child.pid) return;
      if (process.platform === "win32") execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {});
      else { try { process.kill(-child.pid, "SIGKILL"); } catch { /* group already exited */ } }
    };
    const finish = (code: number) => {
      if (done) return;
      done = true; clearTimeout(timer); cleanup();
      resolve({ exitCode: forced ? 1 : code, output });
    };
    const timer = setTimeout(() => { forced = true; cleanup(); finish(1); }, timeoutMs);
    const collect = (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > 256 * 1024) { forced = true; cleanup(); finish(1); return; }
      output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    child.on("error", () => finish(1));
    child.on("exit", code => finish(typeof code === "number" && code >= 0 && code < 256 ? code : 1));
  });
}

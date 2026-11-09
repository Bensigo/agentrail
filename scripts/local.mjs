#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { existsSync, openSync, closeSync } from "node:fs";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const isJace = pkg.name === "@heyjace/platform",
  product = isJace ? "jace" : "agentrail",
  action = process.argv[2] || "up";
const random = () => randomBytes(32).toString("hex");
await mkdir(".local", { recursive: true, mode: 0o700 });
if (!existsSync(".local/env")) {
  const defaults = {
    CONSOLE_PORT: isJace ? "3001" : "3000",
    PG_PORT: isJace ? "25432" : "15432",
    CLICKHOUSE_PORT: isJace ? "28123" : "18123",
    MINIO_PORT: isJace ? "29000" : "19000",
    MINIO_CONSOLE_PORT: isJace ? "29001" : "19001",
    COORDINATOR_PORT: "2001",
    POSTGRES_PASSWORD: random(),
    AUTH_SECRET: random(),
    CONNECTOR_SECRET_KEY: random(),
    MINIO_PASSWORD: random(),
    JACE_CONSOLE_TOKEN: random(),
    JACE_HOSTED_INBOUND_TOKEN: random(),
    JACE_CONTEXT_PACK_REGENERATION_WORKER_TOKEN: random(),
    JACE_MODEL_BASE_URL: "http://127.0.0.1:11434/v1",
    JACE_MODEL_ID: "qwen3:4b",
    JACE_MODEL_CONTEXT_WINDOW_TOKENS: "32768",
    JACE_MODEL_API_KEY: "",
    GITHUB_APP_CLIENT_ID: "",
    GITHUB_APP_CLIENT_SECRET: "",
    GITHUB_APP_ID: "",
    GITHUB_APP_PRIVATE_KEY: "",
    GITHUB_APP_SLUG: "",
  };
  await writeFile(
    ".local/env",
    "# Generated local-only configuration; do not commit.\n" +
      Object.entries(defaults)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n") +
      "\n",
    { mode: 0o600 },
  );
}
await chmod(".local/env", 0o600);
const settings = parseEnv(await readFile(".local/env", "utf8"));
const base = `http://127.0.0.1:${settings.CONSOLE_PORT}`;
const coordinatorPort = settings.COORDINATOR_PORT || "2001";
const database = `postgres://agentrail:${settings.POSTGRES_PASSWORD}@127.0.0.1:${settings.PG_PORT}/agentrail`;
const runtime = {
  ...process.env,
  ...settings,
  DATABASE_URL: database,
  AUTH_URL: base,
  AGENTRAIL_PUBLIC_URL: base,
  LOCAL_OPERATOR_LOGIN: "1",
  AUTH_COOKIE_PREFIX: `${product}-local`,
  AUTH_TRUST_HOST: "true",
  CLICKHOUSE_URL: `http://127.0.0.1:${settings.CLICKHOUSE_PORT}`,
  CLICKHOUSE_USER: "agentrail",
  CLICKHOUSE_PASSWORD: settings.POSTGRES_PASSWORD,
  CLICKHOUSE_DB: "agentrail",
  S3_ENDPOINT: `http://127.0.0.1:${settings.MINIO_PORT}`,
  S3_ACCESS_KEY: "agentrail",
  S3_SECRET_KEY: settings.MINIO_PASSWORD,
  S3_BUCKET: "agentrail-artifacts",
  S3_REGION: "us-east-1",
  S3_FORCE_PATH_STYLE: "true",
  NEXT_TELEMETRY_DISABLED: "1",
  EVE_HOST: `http://127.0.0.1:${coordinatorPort}`,
  JACE_CONSOLE_BASE_URL: base,
  WORKFLOW_TARGET_WORLD: "@workflow/world-postgres",
  WORKFLOW_POSTGRES_URL: database,
  HOST: "127.0.0.1",
  NITRO_HOST: "127.0.0.1",
  CONSOLE_CHAT_ENABLED: isJace ? "1" : "0",
};
runtime.JACE_MODEL_BASE_URL = runtime.JACE_MODEL_BASE_URL.replace(
  "host.docker.internal",
  "127.0.0.1",
);
const compose = [
  "compose",
  "--env-file",
  ".local/env",
  "-f",
  "compose.local-data.yml",
];
async function command(bin, args, env = process.env) {
  const child = spawn(bin, args, { stdio: "inherit", env });
  const [code] = await once(child, "exit");
  if (code !== 0) throw new Error(`${bin} exited ${code}`);
}
async function state() {
  try {
    return JSON.parse(await readFile(".local/processes.json", "utf8"));
  } catch {
    return { processes: [] };
  }
}
function isOurs(item) {
  try {
    return execFileSync("ps", ["-p", String(item.pid), "-o", "command="], {
      encoding: "utf8",
    }).includes(root);
  } catch {
    return false;
  }
}
async function stopApps() {
  const previous = await state(),
    remaining = [];
  for (const item of previous.processes || []) {
    if (!isOurs(item)) continue;
    const alive = () => {
      try {
        process.kill(process.platform === "win32" ? item.pid : -item.pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      if (process.platform === "win32")
        execFileSync("taskkill", ["/pid", String(item.pid), "/t", "/f"], {
          stdio: "ignore",
        });
      else process.kill(-item.pid, "SIGTERM");
      for (let n = 0; n < 40 && alive(); n++)
        await new Promise((r) => setTimeout(r, 125));
      if (alive())
        process.kill(
          process.platform === "win32" ? item.pid : -item.pid,
          "SIGKILL",
        );
      for (let n = 0; n < 20 && alive(); n++)
        await new Promise((r) => setTimeout(r, 100));
      if (alive()) remaining.push(item);
    } catch (error) {
      if (error.code !== "ESRCH") remaining.push(item);
    }
  }
  await writeFile(
    ".local/processes.json",
    JSON.stringify({ processes: remaining }),
    { mode: 0o600 },
  );
  if (remaining.length)
    throw new Error(
      "Some local application processes did not stop; their records were preserved in .local/processes.json.",
    );
}
async function startApp(name, args, env, cwd = root) {
  const previous = await state();
  const existing = previous.processes.find((p) => p.name === name);
  if (existing && isOurs(existing)) return;
  const fd = openSync(`.local/${name}.log`, "a", 0o600);
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", fd, fd],
  });
  await once(child, "spawn");
  child.unref();
  closeSync(fd);
  previous.processes = previous.processes.filter((p) => p.name !== name);
  previous.processes.push({ name, pid: child.pid });
  await writeFile(".local/processes.json", JSON.stringify(previous), {
    mode: 0o600,
  });
  return child;
}
async function waitHttp(url, child) {
  for (let i = 0; i < 90; i++) {
    if (child && (child.exitCode !== null || child.signalCode !== null))
      throw new Error(
        `Application exited before readiness: ${url}. Inspect .local/*.log.`,
      );
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
      await response.body?.cancel();
      if (i === 0)
        console.log(`Waiting for ${url} (HTTP ${response.status})...`);
    } catch (error) {
      if (i === 0)
        console.log(`Waiting for ${url} (${error.name}: ${error.message})...`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Service not ready: ${url}. Inspect .local/*.log.`);
}
async function openConsole() {
  const requireDb = createRequire(
    resolve(root, "packages/db-postgres/package.json"),
  );
  const sql = requireDb("postgres")(database, { max: 1 });
  const code = random();
  try {
    await sql.begin(async (tx) => {
      const email = `${product}-operator@localhost.invalid`;
      const user =
        await tx`INSERT INTO users (id,name,email) VALUES (${randomUUID()},${`${isJace ? "Jace" : "AgentRail"} local operator`},${email}) ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name RETURNING id`;
      const workspace =
        await tx`INSERT INTO workspaces (id,name,slug,hosted_execution,require_alignment) VALUES (${randomUUID()},${`${isJace ? "Jace" : "AgentRail"} local`},${`${product}-local`},false,false) ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`;
      await tx`INSERT INTO workspace_memberships (user_id,workspace_id,role) VALUES (${user[0].id},${workspace[0].id},'owner') ON CONFLICT (user_id,workspace_id) DO NOTHING`;
      if (isJace)
        await tx`INSERT INTO connectors (workspace_id,provider,enabled,config) VALUES (${workspace[0].id},'jace',true,'{}'::jsonb) ON CONFLICT (workspace_id,provider) DO NOTHING`;
      await tx`DELETE FROM verification_tokens WHERE identifier=${`local-login:${user[0].id}`} AND expires<now()`;
      await tx`INSERT INTO verification_tokens (identifier,token,expires) VALUES (${`local-login:${user[0].id}`},${createHash("sha256").update(code).digest("hex")},${new Date(Date.now() + 120000)})`;
    });
  } finally {
    await sql.end();
  }
  const url = `${base}/api/local/login?code=${code}`;
  await writeFile(".local/login-url", url, { mode: 0o600 });
  console.log(`${isJace ? "Jace" : "AgentRail"} Console: ${base}`);
  if (process.env.LOCAL_NO_BROWSER === "1") {
    console.log(
      "One-use sign-in URL written to .local/login-url (expires in two minutes).",
    );
    return;
  }
  const bin =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  try {
    await command(
      bin,
      process.platform === "win32" ? ["/c", "start", "", url] : [url],
    );
  } catch {
    console.log("Open the one-use link stored in .local/login-url.");
  }
}
async function requireFreePort(port) {
  for (let i = 0; i < 20; i++) {
    const server = createServer();
    try {
      await new Promise((ok, fail) => {
        server.once("error", fail);
        server.listen(Number(port), "127.0.0.1", ok);
      });
      await new Promise((ok) => server.close(ok));
      return;
    } catch (error) {
      server.close();
      if (error.code !== "EADDRINUSE") throw error;
      await new Promise((ok) => setTimeout(ok, 250));
    }
  }
  throw new Error(
    `Port ${port} is occupied. Choose a different port in .local/env; other services were left running.`,
  );
}
if (action === "up") {
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw new Error(
      "Node 24 is required. Activate the version in .nvmrc and rerun.",
    );
  await stopApps();
  await requireFreePort(settings.CONSOLE_PORT);
  if (isJace) await requireFreePort(coordinatorPort);
  const venvPython =
    process.platform === "win32"
      ? ".venv/Scripts/python.exe"
      : ".venv/bin/python";
  const venvBin =
    process.platform === "win32"
      ? ".venv/Scripts/agentrail.exe"
      : ".venv/bin/agentrail";
  if (!existsSync(venvBin)) {
    await command("python3", ["-m", "venv", ".venv"]);
    await command(venvPython, ["-m", "pip", "install", "-e", "."]);
  }
  runtime.AGENTRAIL_BIN = resolve(root, venvBin);
  runtime.JACE_AGENTRAIL_BIN = runtime.AGENTRAIL_BIN;
  await command("pnpm", ["--filter", "@agentrail/github-app", "build"]);
  await command("pnpm", ["--filter", "@agentrail/db-postgres", "build"]);
  await command("pnpm", ["--filter", "@agentrail/mcp", "build"]);
  await command("docker", [...compose, "up", "-d", "--wait"]);
  await command(
    "pnpm",
    ["--filter", "@agentrail/db-postgres", "migrate"],
    runtime,
  );
  await command(
    "pnpm",
    ["--filter", "@agentrail/db-clickhouse", "db:migrate"],
    runtime,
  );
  await command(
    process.execPath,
    [resolve(root, "apps/console/scripts/local-storage-init.mjs")],
    runtime,
  );
  await command(
    "pnpm",
    ["--filter", "@agentrail/console", "exec", "fumadocs-mdx"],
    runtime,
  );
  const consoleChild = await startApp(
    "console",
    [
      resolve(root, "apps/console/node_modules/next/dist/bin/next"),
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      settings.CONSOLE_PORT,
    ],
    runtime,
    resolve(root, "apps/console"),
  );
  await waitHttp(`${base}/login`, consoleChild);
  if (isJace) {
    const npmBin = resolve(process.execPath, "../npm");
    if (!existsSync("apps/jace/node_modules/eve/bin/eve.js"))
      await command(npmBin, ["--prefix", resolve(root, "apps/jace"), "ci"]);
    const jaceEnv = { ...runtime, PORT: coordinatorPort };
    await command(
      process.execPath,
      [
        resolve(
          root,
          "apps/jace/node_modules/@workflow/world-postgres/bin/setup.js",
        ),
      ],
      jaceEnv,
    );
    await command(
      npmBin,
      ["--prefix", resolve(root, "apps/jace"), "run", "build"],
      jaceEnv,
    );
    const coordinatorChild = await startApp(
      "coordinator",
      [
        resolve(root, "apps/jace/node_modules/eve/bin/eve.js"),
        "start",
        "--host",
        "127.0.0.1",
        "--port",
        coordinatorPort,
      ],
      jaceEnv,
      resolve(root, "apps/jace"),
    );
    await waitHttp(
      `http://127.0.0.1:${coordinatorPort}/eve/v1/health`,
      coordinatorChild,
    );
    await startApp(
      "review-worker",
      [resolve(root, "apps/jace/scripts/review-worker.mjs")],
      runtime,
    );
    const packEnv = {
      PATH: process.env.PATH,
      JACE_CONSOLE_BASE_URL: base,
      JACE_CONTEXT_PACK_REGENERATION_WORKER: "1",
      JACE_CONTEXT_PACK_REGENERATION_WORKER_TOKEN:
        settings.JACE_CONTEXT_PACK_REGENERATION_WORKER_TOKEN,
    };
    await startApp(
      "context-pack-worker",
      [resolve(root, "apps/jace/scripts/context-pack-regeneration-worker.mjs")],
      packEnv,
    );
  }
  await openConsole();
} else if (action === "down") {
  await stopApps();
  await command("docker", [...compose, "down"]);
} else if (action === "open") await openConsole();
else if (action === "status") {
  await command("docker", [...compose, "ps"]);
  for (const item of (await state()).processes)
    console.log(`${item.name}: ${isOurs(item) ? "running" : "stopped"}`);
} else if (action === "configure")
  console.log("Local configuration ready in .local/env.");
else throw new Error("Use up, down, open, status or configure.");

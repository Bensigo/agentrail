import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { runReviewUiExecution } from "./review_ui_execution_console.core.mjs";
import { createReviewUiExecutor } from "./review_ui_executor.core.mjs";

export const DEFAULT_AGENT_BROWSER_MCP_URL = "http://localhost:8932/mcp";
const CONSOLE_TIMEOUT_MS = 12_000;

export function resolveReviewBrowserUrl(env = {}) {
  const configured = typeof env.JACE_AGENT_BROWSER_MCP_URL === "string"
    ? env.JACE_AGENT_BROWSER_MCP_URL.trim()
    : "";
  return configured || DEFAULT_AGENT_BROWSER_MCP_URL;
}

export function createStreamableBrowserClient({ url }) {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: "jace-review-ui", version: "0.0.0" });
  return {
    connect: () => client.connect(transport),
    listTools: () => client.listTools(),
    callTool: (input) => client.callTool(input),
    close: () => client.close(),
  };
}

async function realTransport(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONSOLE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { status: response.status, json: () => response.json() };
  } finally {
    clearTimeout(timer);
  }
}

/** Production composition: Console reservation + fixed browser MCP + receipt. */
export function createReviewUiExecuteFn({
  env = process.env,
  transport = realTransport,
  createClient = createStreamableBrowserClient,
} = {}) {
  const browserUrl = resolveReviewBrowserUrl(env);
  return (input) =>
    runReviewUiExecution({
      ...input,
      env,
      transport,
      execute: ({ context, completeExecution }) => {
        const execute = createReviewUiExecutor({
          createClient: () => createClient({ url: browserUrl }),
          completeExecution,
        });
        return execute(context);
      },
    });
}

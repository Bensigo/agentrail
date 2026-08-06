import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createVerificationBrowserExecutor } from "./verification_browser_executor.core.mjs";
import { runUploadVerificationArtifact } from "../subagents/qa/lib/upload_verification_artifact.core.mjs";

export const DEFAULT_AGENT_BROWSER_MCP_URL = "http://localhost:8932/mcp";

export function resolveVerificationBrowserMcpUrl(env = {}) {
  const configured = typeof env.JACE_AGENT_BROWSER_MCP_URL === "string" ? env.JACE_AGENT_BROWSER_MCP_URL.trim() : "";
  return configured || DEFAULT_AGENT_BROWSER_MCP_URL;
}

export function createStreamableBrowserClient({ url }) {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: "jace-verification-browser", version: "0.0.0" });
  return {
    connect: () => client.connect(transport),
    listTools: () => client.listTools(),
    callTool: (input) => client.callTool(input),
    close: () => client.close(),
  };
}

/** Build the production UI-only execution function; API execution remains separate. */
export function createVerificationBrowserExecuteFn({ env = process.env, createClient = createStreamableBrowserClient, uploadArtifact } = {}) {
  const upload = uploadArtifact ?? ((input) => runUploadVerificationArtifact({
    ...input,
    env,
    transport: async (url, init) => {
      const response = await fetch(url, init);
      return { status: response.status, json: () => response.json() };
    },
  }));
  const execute = createVerificationBrowserExecutor({
    createClient: ({ url }) => createClient({ url: url || resolveVerificationBrowserMcpUrl(env) }),
    uploadArtifact: upload,
  });
  return (item) => execute({ ...item, agentBrowserMcpUrl: resolveVerificationBrowserMcpUrl(env) });
}

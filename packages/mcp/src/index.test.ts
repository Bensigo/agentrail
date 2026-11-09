import { describe, expect, it, vi } from "vitest";
const tools = vi.hoisted(() => vi.fn());
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({ McpServer: class { registerTool(...args: unknown[]) { tools(...args); } async connect() {} } }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
const source = await import("./index.js");
describe("independent AgentRail MCP surface", () => {
 it("exposes context and agent-neutral workflow without Jace tools", () => {
  const names = tools.mock.calls.map(([name]) => name);
  expect(names).toContain("workflow_start"); expect(names).toContain("context_search");
  expect(names.some(n => n.startsWith("jace_") || n.startsWith("acceptance_"))).toBe(false);
 });
 it("keeps workflow and Jace secrets out of configured check children", () => {
  const env = source.agentrailChildEnvironment({ PATH: "/bin", AGENTRAIL_WORKFLOW_API_KEY: "workflow", AGENTRAIL_MCP_JACE_API_KEY: "jace", AGENTRAIL_MCP_CORRECTION_API_KEY: "correction" });
  expect(env).toEqual({ PATH: "/bin" });
 });
});

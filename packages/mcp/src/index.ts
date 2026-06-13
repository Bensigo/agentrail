#!/usr/bin/env node
/**
 * AgentRail context MCP server.
 *
 * Exposes AgentRail's compact context retrieval as native MCP tools so coding
 * agents (Claude, Cursor, Codex, ...) prefer it over raw file search/read:
 *   - context_search       ranked path + line range + symbol + snippet candidates
 *   - context_get          only the requested line range / symbol block (never whole files)
 *   - context_build_pack    a bounded context pack for an issue or PR
 *   - context_explain_pack  why sources were included / excluded / boosted / demoted
 *   - context_def          symbol definition lookup by name (house-schema JSON)
 *   - context_callers      inbound call-graph edges for a symbol (house-schema JSON)
 *   - context_callees      outbound call-graph edges for a symbol (house-schema JSON)
 *   - context_impact       transitive callers + linked tests (blast-radius, house-schema JSON)
 *
 * Each tool shells out to the existing `agentrail context ...` CLI (so there is
 * one source of truth for retrieval behaviour). The CLI binary is resolved from
 * AGENTRAIL_BIN, else `agentrail` on PATH. The repo to operate on defaults to
 * AGENTRAIL_TARGET or the server's working directory, and can be overridden per
 * call with the `target` argument.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const AGENTRAIL_BIN = process.env.AGENTRAIL_BIN || "agentrail";
const DEFAULT_TARGET = process.env.AGENTRAIL_TARGET || process.cwd();

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

async function runAgentrail(args: string[]): Promise<ToolResult> {
  try {
    const { stdout } = await execFileAsync(AGENTRAIL_BIN, args, {
      maxBuffer: 16 * 1024 * 1024,
    });
    const text = stdout.trim();
    let structuredContent: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") {
        structuredContent = Array.isArray(parsed) ? { results: parsed } : parsed;
      }
    } catch {
      /* non-JSON output is returned as text only */
    }
    return { content: [{ type: "text", text: text || "(no output)" }], structuredContent };
  } catch (error) {
    const err = error as { stderr?: string; message?: string; code?: string };
    const detail = (err.stderr || err.message || String(error)).trim();
    return {
      content: [
        {
          type: "text",
          text:
            `agentrail command failed: ${detail}\n` +
            `Checked binary '${AGENTRAIL_BIN}'. Set AGENTRAIL_BIN to the agentrail CLI path, ` +
            `and pass 'target' (or set AGENTRAIL_TARGET) to a repo that has been indexed ` +
            `(run 'agentrail context index' there first).`,
        },
      ],
      isError: true,
    };
  }
}

function withTarget(args: string[], target?: string): string[] {
  return [...args, "--target", target || DEFAULT_TARGET, "--json"];
}

const server = new McpServer({ name: "agentrail-context", version: "0.1.0" });

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

server.registerTool(
  "context_search",
  {
    title: "AgentRail context search",
    description:
      "Find the most relevant code for a query and return ranked candidates as " +
      "path + line range + symbol + bounded snippet + reason + score. Use this " +
      "BEFORE broad repo exploration; do not read whole files until this returns " +
      "candidate line ranges.",
    inputSchema: {
      query: z.string().min(1).describe("Natural-language or symbol/path/error query."),
      target: z.string().optional().describe("Repo directory to search (defaults to AGENTRAIL_TARGET/cwd)."),
      limit: z.number().int().min(1).max(50).optional().describe("Max candidates (default 10)."),
    },
    annotations: READ_ONLY,
  },
  async ({ query, target, limit }) => {
    const args = ["context", "search", query];
    if (limit) args.push("--limit", String(limit));
    return runAgentrail(withTarget(args, target));
  },
);

server.registerTool(
  "context_get",
  {
    title: "AgentRail context get",
    description:
      "Return ONLY the requested line range or symbol block of a file — never the " +
      "whole file. Use after context_search to expand a specific candidate.",
    inputSchema: {
      path: z.string().min(1).describe("Repo-relative file path."),
      lines: z
        .string()
        .regex(/^\d+-\d+$/)
        .optional()
        .describe("Inclusive line range 'A-B', e.g. '12-48'."),
      symbol: z.string().optional().describe("Symbol name to return its definition range."),
      target: z.string().optional().describe("Repo directory (defaults to AGENTRAIL_TARGET/cwd)."),
    },
    annotations: READ_ONLY,
  },
  async ({ path, lines, symbol, target }) => {
    if ((lines && symbol) || (!lines && !symbol)) {
      return {
        content: [{ type: "text", text: "Provide exactly one of 'lines' (A-B) or 'symbol'." }],
        isError: true,
      };
    }
    const args = ["context", "get", path];
    if (lines) args.push("--lines", lines);
    if (symbol) args.push("--symbol", symbol);
    return runAgentrail(withTarget(args, target));
  },
);

server.registerTool(
  "context_build_pack",
  {
    title: "AgentRail build context pack",
    description:
      "Build a bounded context pack for an issue or PR phase (the same pack used by " +
      "'agentrail run'). Returns selected sources, citations, and token budget.",
    inputSchema: {
      kind: z.enum(["issue", "pr"]).describe("Pack target kind."),
      number: z.number().int().positive().describe("Issue or PR number."),
      phase: z
        .enum(["plan", "execute", "verify", "review"])
        .describe("issue: plan|execute|verify; pr: review."),
      target: z.string().optional().describe("Repo directory (defaults to AGENTRAIL_TARGET/cwd)."),
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ kind, number, phase, target }) => {
    const args = ["context", "build", kind, String(number), "--phase", phase];
    return runAgentrail(withTarget(args, target));
  },
);

server.registerTool(
  "context_explain_pack",
  {
    title: "AgentRail explain context pack",
    description: "Explain why sources were included, excluded, boosted, or demoted in a pack.",
    inputSchema: {
      pack: z.string().min(1).describe("Pack id or pack file path."),
      target: z.string().optional().describe("Repo directory (defaults to AGENTRAIL_TARGET/cwd)."),
    },
    annotations: READ_ONLY,
  },
  async ({ pack, target }) => {
    return runAgentrail(withTarget(["context", "explain", pack], target));
  },
);

server.registerTool(
  "context_def",
  {
    title: "AgentRail context def",
    description:
      "Look up the definition(s) of a symbol by name; returns house-schema JSON candidates " +
      "from the global symbol table. Multi-definition symbols (overloads, same name in " +
      "multiple files) return all matches. Denied sources are excluded.",
    inputSchema: {
      name: z.string().min(1).describe("Symbol name to look up."),
      target: z.string().optional().describe("Repo directory (defaults to AGENTRAIL_TARGET/cwd)."),
    },
    annotations: READ_ONLY,
  },
  async ({ name, target }) => {
    return runAgentrail(withTarget(["context", "def", name], target));
  },
);

server.registerTool(
  "context_callers",
  {
    title: "AgentRail context callers",
    description:
      "Find inbound call-graph edges for a symbol by name; returns house-schema JSON with " +
      "callerPath and callerLine fields. Unresolved edges include a reason field.",
    inputSchema: {
      name: z.string().min(1).describe("Symbol name to find callers for."),
      target: z.string().optional().describe("Repo directory (defaults to AGENTRAIL_TARGET/cwd)."),
    },
    annotations: READ_ONLY,
  },
  async ({ name, target }) => {
    return runAgentrail(withTarget(["context", "callers", name], target));
  },
);

server.registerTool(
  "context_callees",
  {
    title: "AgentRail context callees",
    description:
      "Find outbound call-graph edges from a symbol by name; returns house-schema JSON " +
      "listing what the symbol calls. Unresolved edges include a reason field.",
    inputSchema: {
      name: z.string().min(1).describe("Symbol name to find callees for."),
      target: z.string().optional().describe("Repo directory (defaults to AGENTRAIL_TARGET/cwd)."),
    },
    annotations: READ_ONLY,
  },
  async ({ name, target }) => {
    return runAgentrail(withTarget(["context", "callees", name], target));
  },
);

server.registerTool(
  "context_impact",
  {
    title: "AgentRail context impact",
    description:
      "Assess blast radius for a symbol: transitive callers (BFS to depth N) plus tests " +
      "linked via tests_source edges and files with imports_file edges; returns house-schema JSON.",
    inputSchema: {
      name: z.string().min(1).describe("Symbol name to assess impact for."),
      depth: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("BFS traversal depth (default 3)."),
      target: z.string().optional().describe("Repo directory (defaults to AGENTRAIL_TARGET/cwd)."),
    },
    annotations: READ_ONLY,
  },
  async ({ name, depth, target }) => {
    const args = ["context", "impact", name];
    if (depth) args.push("--depth", String(depth));
    return runAgentrail(withTarget(args, target));
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("agentrail-mcp failed to start:", error);
  process.exit(1);
});

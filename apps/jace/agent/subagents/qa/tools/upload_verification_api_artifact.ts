import { defineTool } from "eve/tools";
import { z } from "zod";
import { runUploadVerificationApiArtifact } from "../lib/upload_verification_api_artifact.core.mjs";

export default defineTool({
  description: "Upload one redacted API request/response/assertion card through the exact Acceptance Record verification plan supplied by the execution task.",
  inputSchema: z.object({ workspaceId: z.string().min(1), recordId: z.string().min(1), prRevisionId: z.string().min(1), verificationPlanId: z.string().min(1), index: z.number().int().positive(), evidence: z.object({ request: z.object({ method: z.string().min(1), url: z.string().min(1) }), response: z.object({ status: z.number().int() }).passthrough(), assertions: z.array(z.string().min(1)).min(1).max(20) }).passthrough() }),
  async execute(input, ctx) { return runUploadVerificationApiArtifact({ ...input, collectedBy: `qa:${ctx?.session?.id ?? "unknown"}`, env: process.env, transport: async (url, init) => { const response = await fetch(url, init); return { status: response.status, json: () => response.json() }; } }); },
});

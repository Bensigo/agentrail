import { defineTool } from "eve/tools";
import { z } from "zod";
import { runUploadVerificationArtifact } from "../lib/upload_verification_artifact.core.mjs";

export default defineTool({
  description: "Upload one browser screenshot through a claimed Jace verification plan. Use only the workspace, record, PR revision, and plan IDs supplied by the execution task; never substitute repo or PR coordinates. Returns a durable artifactId and signed URL.",
  inputSchema: z.object({ workspaceId: z.string().min(1), recordId: z.string().min(1), prRevisionId: z.string().min(1), verificationPlanId: z.string().min(1), index: z.number().int().positive(), imageBase64: z.string().min(1), contentType: z.enum(["image/png", "image/jpeg"]), observedUrl: z.string().url() }),
  async execute(input, ctx) {
    return runUploadVerificationArtifact({ ...input, collectedBy: `qa:${ctx?.session?.id ?? "unknown"}`, env: process.env, transport: async (url, init) => { const response = await fetch(url, init); return { status: response.status, json: () => response.json() }; } });
  },
});

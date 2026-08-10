// request_preview_boot — root's ungated seam onto the console preview-boot
// plane. The pure orchestration lives in request_preview_boot.core.mjs; this
// wrapper only binds Eve's root session id and the real fetch/sleep/clock
// dependencies.

import { defineTool } from "eve/tools";
import { z } from "zod";
import { requestPreviewBoot } from "../lib/request_preview_boot.core.mjs";

const TIMEOUT_MS = 8000;

async function realTransport(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<{ status: number; json: () => Promise<unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return { status: res.status, json: () => res.json() };
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default defineTool({
  description:
    "Request a sandboxed preview boot for the current review job, then poll " +
    "the console until it returns a booted URL or a stable degraded result. " +
    "Use this only when reviewing a PR with behavioral acceptance criteria " +
    "and no server-attested preview URL. The console derives the workspace, " +
    "repository, PR, and exact head from the bound review job; they are never " +
    "accepted from model input. Ungated by design: review jobs are " +
    "headless, and this tool never merges, deploys, comments, or mutates " +
    "the repository. It returns degraded results instead of throwing when " +
    "the console is unavailable, preview boots are disabled, the workspace " +
    "is not enrolled, or the boot does not become ready. Only results with " +
    "attestedState and attestedObservation may become criterion outcomes; " +
    "a ready environment remains not_proven unless a separate server-custodied " +
    "criterion execution receipt exists.",
  inputSchema: z.object({
    jobId: z.string().min(1).describe("The current review job id from the headless review prompt."),
  }),
  async execute(input, ctx) {
    return requestPreviewBoot({
      eveSessionId: ctx.session.id,
      jobId: input.jobId,
      env: process.env,
      transport: realTransport,
      sleep,
      now: Date.now,
    });
  },
});

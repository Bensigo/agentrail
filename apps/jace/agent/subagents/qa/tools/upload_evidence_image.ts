// upload_evidence_image — QA's ONE authored tool, and the ONE write
// capability this otherwise fully read-only, isolated subagent carries (see
// agent.ts's own header for the fuller AC3 argument). It uploads ONE
// captured screenshot (base64 image bytes QA already has from a browser
// connection's screenshot tool — agent_browser_screenshot / browser_
// screenshot, already allowlisted; see lib/connections.core.mjs) to the
// console's purpose-built evidence-image store
// (apps/console/app/api/v1/runner/review-evidence, POST — Task 2, merged)
// and returns the resulting signed URL for that AC's `evidence_images`
// (qa.core.mjs's QA_SCHEMA). Design: docs/superpowers/specs/
// 2026-08-02-b2-behavioral-evidence-design.md §2 (B2a). All orchestration
// lives in lib/upload_evidence_image.core.mjs (pure, injected transport);
// this wrapper only binds the real transport and resolves the session id.
//
// NOT THE FORBIDDEN BROWSER-UPLOAD CAPABILITY: QA_FORBIDDEN_TOOL_PATTERNS
// (lib/connections.core.mjs) blocks any MCP *sidecar* tool matching /upload/i
// from the browser-driving allowlists — that guards against QA uploading an
// arbitrary FILE INTO A THIRD-PARTY PAGE through the browser it drives. This
// tool does the opposite: it takes bytes QA already captured (a screenshot)
// and writes them to Jace's OWN evidence store, never touching the browser
// or any third-party site. Same word, unrelated and non-conflicting
// capability — mirrors the console route's own doc-comment, which
// disambiguates its "evidence" from an unrelated same-named system.
//
// BOUNDED WRITE, narrowly scoped — the same class of argument
// no-second-write-path.test.mjs's header makes for root's own enumerated
// UNGATED-but-scoped writes (post_pr_review, save_brief, save_investigation):
// this tool can never file an issue, post to GitHub, or touch any Jace
// system other than the one console endpoint built for exactly this
// purpose. Its blast radius is "one image, one AC, one PR the calling
// workspace already owns" — the console route re-derives the workspace from
// the session and gates the repo on `getRepositoryByName`, so a model-chosen
// repo/PR cannot escape the tenant (the same server-scoped-target argument
// post_pr_review.core.mjs's own header makes for its console call).
//
// UNGATED, deliberately: the write is narrow and purely additive (it can
// only ever ADD one artifact; nothing is ever deleted, overwritten, or
// exposed publicly — signed URLs only). Gating a per-AC-per-screenshot call
// behind a human approval would reproduce the exact prod failure
// post_pr_review's own header documents: the console only ever delivers
// approval prompts on Telegram, so on every other channel the request would
// sit recorded, never shown, and evidence capture would silently stop
// working there.
//
// SESSION RESOLUTION: same as the reviewer subagent's context tools (e.g.
// read_repo_file.ts) — `ctx.session.parent?.rootSessionId ?? ctx.session.id`.
// This tool runs inside the `qa` DECLARED SUBAGENT, which eve gives its own
// CHILD session; the fallback is defensive only. See read_repo_file.ts's own
// doc-comment for the full reasoning.
//
// PR COORDINATES ARE CALLER-SUPPLIED, NOT DISCOVERED: `repo` / `prNumber` /
// `headSha` are not looked up here — root's task prompt to QA carries the PR
// under test, and QA relays those coordinates verbatim as this tool's own
// arguments, same provenance as the reviewer's fetch_pr_diff `repo`/
// `prNumber`. This tool cannot independently verify they name the PR
// actually under test; that trust boundary is the same one every other
// console-calling tool in this app already carries for its model-supplied
// `repo`/`prNumber`.

import { defineTool } from "eve/tools";
import { z } from "zod";
import { runUploadEvidenceImage } from "../lib/upload_evidence_image.core.mjs";

// Stdlib `fetch` with a timeout — mirrors read_repo_file.ts / post_pr_review.ts's
// own realTransport idiom (an AbortController aborts the in-flight request
// after TIMEOUT_MS), so a hung console call can never hang this tool call,
// and therefore the conversation turn, indefinitely.
const TIMEOUT_MS = 8000;

async function realTransport(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
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

export default defineTool({
  description:
    "Upload ONE captured screenshot as evidence for ONE acceptance criterion, " +
    "and get back a signed URL to record in that AC's evidence_images. Call " +
    "this right after taking a decisive screenshot with a browser " +
    "connection's screenshot tool (agent_browser_screenshot / " +
    "browser_screenshot) — pass its raw image bytes here as base64. Pass the " +
    "SAME repo/prNumber/headSha you were given for this PR (they ride in " +
    "your task prompt — this tool does not discover them), the acId this " +
    "screenshot is evidence for, and index for which screenshot this is for " +
    "that AC (at most 4 per AC). On success you get { url, key } — put url " +
    "in that ac_result's evidence_images. On failure you get { error } " +
    "describing what went wrong in plain language — this never throws, so " +
    "report the error plainly in your findings/evidence rather than " +
    "inventing a URL or silently dropping the evidence.",
  inputSchema: z.object({
    acId: z.string().min(1).describe("The acceptance criterion this screenshot is evidence for."),
    index: z
      .number()
      .int()
      .min(1)
      .max(4)
      .describe("Which screenshot this is for this AC (1-4) — at most 4 images per AC."),
    imageBase64: z.string().min(1).describe("The screenshot's raw image bytes, base64-encoded."),
    contentType: z
      .enum(["image/png", "image/jpeg"])
      .describe("The screenshot's image format — only png and jpeg are accepted."),
    repo: z
      .string()
      .min(1)
      .describe("The reviewed repo, as owner/name — given to you in your task, not discovered here."),
    prNumber: z.number().int().positive().describe("The pull request number — given to you in your task."),
    headSha: z.string().min(1).describe("The PR head commit SHA — given to you in your task."),
  }),
  async execute(input, ctx) {
    const eveSessionId = ctx?.session?.parent?.rootSessionId ?? ctx?.session?.id;
    return runUploadEvidenceImage({
      env: process.env,
      eveSessionId,
      repo: input.repo,
      prNumber: input.prNumber,
      headSha: input.headSha,
      acId: input.acId,
      index: input.index,
      imageBase64: input.imageBase64,
      contentType: input.contentType,
      transport: realTransport,
    });
  },
});

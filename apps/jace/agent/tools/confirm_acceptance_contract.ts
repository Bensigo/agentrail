import { defineTool } from "eve/tools";
import { z } from "zod";
import { confirmAcceptanceContractFromBoundIntake } from "../lib/acceptance_intake_confirm.core.mjs";

const TIMEOUT_MS = 8000;
async function realTransport(url: string, init: { method: string; headers: Record<string, string>; body: string }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { status: response.status, json: () => response.json() };
  } finally {
    clearTimeout(timer);
  }
}

export default defineTool({
  description:
    "Request human approval for a draft Acceptance Contract only after the human explicitly confirms it in this new hosted-channel message. " +
    "Never call this in the draft-creation turn, when the human is changing scope, or before they confirm. The workspace, intake, and current inbound provider message are derived from the trusted session. " +
    "This creates an idempotent approval request; it does not confirm the Contract, compile a Context Pack, start implementation, edit code, create a PR, or merge.",
  inputSchema: z.object({ version: z.number().int().positive().describe("The draft contract version the human explicitly confirmed.") }),
  async execute(input, ctx) {
    return confirmAcceptanceContractFromBoundIntake({ sessionAuth: ctx?.session?.auth, eveSessionId: ctx?.session?.id, version: input.version, env: process.env, transport: realTransport });
  },
});

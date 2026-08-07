import { defineTool } from "eve/tools";
import { z } from "zod";
import { requestAcceptanceContextPackFromBoundIntake } from "../lib/acceptance_intake_context_pack.core.mjs";
export default defineTool({ description: "Request bounded Context Pack compilation only after this intake's contract is confirmed. Uses only the trusted session-bound intake; it does not choose a builder, expose source, or claim the worker completed.", inputSchema: z.object({}), async execute(_input, ctx) { return requestAcceptanceContextPackFromBoundIntake({ sessionAuth: ctx?.session?.auth, env: process.env, transport: async (url, init) => { const response = await fetch(url, init); return { status: response.status, json: () => response.json() }; } }); } });

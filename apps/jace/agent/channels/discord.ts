// Jace's native Discord channel (#1050).
//
// Eve's first-class Discord integration: inbound interactions (signature-verified
// via the Ed25519 headers) AND outbound/proactive posting, deferred-response
// editing, and followups — all native. We do NOT hand-roll Discord webhooks or
// bot HTTP. The channel id is this file's name (`discord`), so Eve mounts the
// inbound endpoint at `/eve/v1/discord`.
//
// Self-host credentials come from the environment (no Vercel Connect required):
//   DISCORD_PUBLIC_KEY      — verifies X-Signature-Ed25519 + timestamp
//   DISCORD_APPLICATION_ID  — edits the deferred response / sends followups
//   DISCORD_BOT_TOKEN       — proactive messages + typing indicators
//
// NOTE: shape follows the eve@0.19.0 docs; boot behavior when the env is unset and
// live delivery are verified against the running sidecar (#1038/#1101), behind the
// per-workspace `jaceOwnsDiscordNotify` opt-in.
import { discordChannel } from "eve/channels/discord";

export default discordChannel();

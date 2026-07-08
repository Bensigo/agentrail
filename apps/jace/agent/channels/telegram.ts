// Jace's native Telegram channel (#1047).
//
// This is Eve's first-class Telegram integration — it handles inbound webhook
// updates AND outbound/proactive delivery (repliable threads), signature
// verification, and typing indicators natively. We do NOT hand-roll Telegram HTTP
// or token handling; Eve owns it. The channel id is this file's name (`telegram`),
// so Eve mounts the inbound webhook at `/eve/v1/telegram`.
//
// Self-host credentials come from the environment (no Vercel Connect required):
//   TELEGRAM_BOT_USERNAME        — the bot's @username (without the @)
//   TELEGRAM_BOT_TOKEN           — the BotFather token (proactive sends)
//   TELEGRAM_WEBHOOK_SECRET_TOKEN — the secret token Telegram signs updates with
// After deploy, register the webhook once with Telegram's setWebhook API pointing
// at `https://<host>/eve/v1/telegram` (see apps/jace/README.md).
//
// NOTE: signature/option shape follows the eve@0.19.0 docs; boot behavior when the
// env is unset and live delivery are verified against the running sidecar
// (#1038/#1101), behind the per-workspace `jaceOwnsTelegramNotify` opt-in.
import { telegramChannel } from "eve/channels/telegram";

const botUsername = (process.env["TELEGRAM_BOT_USERNAME"] ?? "").trim();

export default telegramChannel({ botUsername });

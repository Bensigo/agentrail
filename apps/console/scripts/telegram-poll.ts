/**
 * Telegram inbound POLLING driver (local-dev mode for #889).
 *
 * WHY THIS EXISTS
 * ---------------
 * Inbound Telegram (`/status` two-way replies) was added as a WEBHOOK route
 * (`app/api/v1/connectors/telegram/webhook/[workspaceId]/route.ts`). Webhooks
 * require Telegram to reach the server over a public HTTPS URL — impossible on
 * localhost. This standalone poller is the LOCAL-DEV equivalent: it long-polls
 * Telegram's `getUpdates` and feeds each update through the SAME pure decision
 * core the webhook uses (`decideReply`), so behavior is identical.
 *
 * The two modes are environment-exclusive:
 *   - WEBHOOK  — deployed, when AGENTRAIL_SERVER_BASE_URL is a public URL.
 *   - POLLING  — local dev (this script). getUpdates and a registered webhook are
 *     mutually exclusive, so on startup we `deleteTelegramWebhook` per bot first.
 *
 * It is intentionally NOT a Next route: it imports only the pure handler, the
 * stdlib-`fetch` Telegram helpers, and the db-postgres query layer — no Next
 * runtime. Run it with `tsx` alongside `next dev`.
 *
 * RUN (from repo root):
 *   pnpm --filter @agentrail/console telegram:poll
 *   # or directly:
 *   pnpm --filter @agentrail/db-postgres exec tsx --env-file=apps/console/.env.local \
 *     apps/console/scripts/telegram-poll.ts
 *
 * It reads DATABASE_URL + CONNECTOR_SECRET_KEY from apps/console/.env.local
 * (the same env the console uses). Override the poll cadence with
 * TELEGRAM_POLL_INTERVAL_MS (default 3000).
 *
 * AUTHORIZATION is the connector's configured chatId, enforced exactly once
 * inside `decideReply`. This driver adds NO second auth path — an update from a
 * chat that doesn't match the connector's chatId gets no reply.
 *
 * RESILIENCE: a single bad update or a transient getUpdates failure logs and the
 * loop continues — it never crashes. Offset (the getUpdates cursor) is persisted
 * per-connector in `config.telegramOffset` so a restart resumes past already
 * handled updates instead of replaying them.
 */

import {
  listEnabledConnectors,
  getConnectorSecret,
  listQueueEntries,
  upsertConnector,
} from "@agentrail/db-postgres";
import {
  getTelegramUpdates,
  deleteTelegramWebhook,
  sendTelegramMessage,
} from "../app/api/v1/workspaces/[workspaceId]/connectors/secret/telegram";
import { processPollBatch } from "../app/api/v1/connectors/telegram/webhook/poll-core";

const POLL_INTERVAL_MS = Number(
  process.env["TELEGRAM_POLL_INTERVAL_MS"] ?? 3000
);

/** Per-connector in-memory state for one poll cycle. We re-read the connector
 * list each tick so a newly connected bot is picked up without a restart; the
 * offset is sourced from config (persisted) on first sight, then kept in memory
 * AND written back so a restart resumes correctly. */
const offsets = new Map<string, number | undefined>();
/** Bots we've already deleted the webhook for (once per process). */
const webhookCleared = new Set<string>();

function log(msg: string, extra?: unknown): void {
  const ts = new Date().toISOString();
  if (extra !== undefined) console.log(`[telegram-poll ${ts}] ${msg}`, extra);
  else console.log(`[telegram-poll ${ts}] ${msg}`);
}

/** Poll + process one connector once. Best-effort: never throws to the caller. */
async function pollConnector(workspaceId: string, config: {
  chatId?: string;
  telegramOffset?: number;
}): Promise<void> {
  try {
    const chatId = config.chatId;
    if (!chatId) {
      // No target chat → decideReply would stay silent anyway; nothing to do.
      return;
    }

    const token = await getConnectorSecret(workspaceId, "telegram");
    if (!token) return; // secret cleared between list + read; skip this tick.

    // getUpdates and a registered webhook are mutually exclusive — clear once.
    if (!webhookCleared.has(workspaceId)) {
      const del = await deleteTelegramWebhook(token);
      if (!del.ok) {
        log(`deleteWebhook warning ws=${workspaceId}: ${del.error}`);
      }
      // Mark cleared regardless: a transient failure shouldn't loop forever; the
      // next getUpdates 409 (if any) is logged and we retry next process restart.
      webhookCleared.add(workspaceId);
    }

    // Seed the cursor from persisted config the first time we see this connector.
    if (!offsets.has(workspaceId)) {
      offsets.set(workspaceId, config.telegramOffset);
    }
    const offset = offsets.get(workspaceId);

    const got = await getTelegramUpdates(token, offset);
    if (!got.ok) {
      log(`getUpdates failed ws=${workspaceId}: ${got.error}`);
      return;
    }
    if (got.updates.length === 0) return;

    const snapshot = await listQueueEntries(workspaceId, { activeOnly: false });

    const result = await processPollBatch({
      updates: got.updates,
      chatId,
      snapshot,
      offset,
      send: async (text) => {
        await sendTelegramMessage(token, chatId, text);
      },
    });

    // Persist the advanced cursor (memory + config) so a restart resumes past it.
    if (result.offset !== undefined && result.offset !== offset) {
      offsets.set(workspaceId, result.offset);
      try {
        await upsertConnector(workspaceId, "telegram", {
          config: { telegramOffset: result.offset },
        });
      } catch (err) {
        // Failing to persist the offset is non-fatal — the in-memory cursor still
        // prevents reprocessing within this run; we just lose resume-after-restart.
        log(`offset persist failed ws=${workspaceId}`, err);
      }
    }

    if (result.replied > 0) {
      log(
        `ws=${workspaceId}: processed ${result.processed}, replied ${result.replied}, offset=${result.offset}`
      );
    }
  } catch (err) {
    // A bad connector must NOT take down the loop.
    log(`unexpected error polling ws=${workspaceId}`, err);
  }
}

/** One poll tick across all enabled telegram connectors. Never throws. */
async function tick(): Promise<void> {
  let connectors;
  try {
    connectors = await listEnabledConnectors("telegram");
  } catch (err) {
    log("listEnabledConnectors failed (will retry next tick)", err);
    return;
  }
  for (const c of connectors) {
    await pollConnector(c.workspaceId, c.config);
  }
}

async function main(): Promise<void> {
  if (!process.env["DATABASE_URL"]) {
    log(
      "DATABASE_URL is not set — run via `pnpm --filter @agentrail/console telegram:poll` (loads apps/console/.env.local) or export it."
    );
    process.exit(1);
  }
  log(`starting — interval ${POLL_INTERVAL_MS}ms`);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log("shutting down");
    // Give the process a moment to flush, then exit.
    setTimeout(() => process.exit(0), 100);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // Simple sequential loop: tick, wait, repeat. Sequential (not setInterval) so
  // a slow tick can't overlap itself.
  // eslint-disable-next-line no-constant-condition
  while (!stopping) {
    await tick();
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  log("fatal", err);
  process.exit(1);
});

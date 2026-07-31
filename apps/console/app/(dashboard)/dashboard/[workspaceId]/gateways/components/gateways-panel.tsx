"use client";

import { useCallback, useEffect, useState } from "react";
import { MessageCircle } from "lucide-react";
import {
  DiscordBrand,
  SlackBrand,
  TelegramBrand,
} from "../../connectors/components/brand-icons";
import type { GatewayKind, GatewayView } from "./gateway-helpers";
// Relative (not @/…) because lib/ lives outside app/ or src/, the only roots
// the @/* alias covers — mirrors gateway-helpers.ts's identical import of
// lib/telegram-bot and connectors-panel.tsx's import of this same module.
import { linkedIdentitiesLine } from "../../../../../../lib/linked-identities";
// Same self-host docs link the setup wizard's channel step renders
// (`channel-step.tsx`, via `channel-step-helpers.ts`'s re-export) — canonical
// home is `lib/telegram-bot.ts`, imported directly here rather than reaching
// into the setup wizard's private helpers module.
import { SELF_HOST_TELEGRAM_DOCS_URL } from "../../../../../../lib/telegram-bot";

/**
 * The Gateways settings panel (gateways-page T3).
 *
 * Deliberately simpler than `ConnectorsPanel`: there is no `canManage` (the
 * T2 route has no mutations, so no role gating — see the route's doc
 * comment), and — the whole point of this page — NO expand/collapse. A
 * connector card collapses because it hides a credential form; a gateway
 * card is just a title, one description line, and one action, so it must be
 * fully visible the moment the page loads. The previous iteration of this
 * feature buried the Telegram link behind a click; that is exactly what this
 * page must never do again.
 */

// --------------------------------------------------------------------------- //
// Icon — brand glyph for the three shipped gateways, a neutral lucide glyph
// for the two planned ones (never a hand-drawn/invented brand mark for a
// product that isn't shipped).
// --------------------------------------------------------------------------- //
function GatewayIcon({ kind }: { kind: GatewayKind }) {
  switch (kind) {
    case "telegram":
      return <TelegramBrand size={17} className="text-[var(--gray-12)]" />;
    case "discord":
      return <DiscordBrand size={17} className="text-[var(--gray-12)]" />;
    case "slack":
      return <SlackBrand size={17} className="text-[var(--gray-12)]" />;
    case "imessage":
    case "whatsapp":
      return <MessageCircle size={17} className="text-[var(--gray-12)]" />;
  }
}

// --------------------------------------------------------------------------- //
// Per-kind copy. The bot username/app name isn't in `GatewayView`, so these
// are generic per-kind labels/sentences rather than anything that names a
// specific bot — see gateways-page T3 brief §5.
// --------------------------------------------------------------------------- //

/** Primary CTA label for an available+configured gateway. */
function connectCtaLabel(kind: GatewayKind): string {
  switch (kind) {
    case "telegram":
      return "Message Jace on Telegram";
    case "discord":
      return "Add to Discord";
    case "slack":
      return "Add to Slack";
    case "imessage":
    case "whatsapp":
      // Unreachable: a planned kind always resolves to the "planned" card
      // state before this label is read (see resolveCardState) — kept for
      // exhaustiveness, mirroring buildActionUrl's identical unreachable arms
      // in gateway-helpers.ts.
      return "";
  }
}

/**
 * What's missing, in plain words, for an available-but-unconfigured gateway.
 * Names the DEPLOYMENT, not the workspace (whole-branch review fix 2): these
 * are deploy-wide `NEXT_PUBLIC_*` env vars, not a per-workspace setting, and
 * there is no per-workspace configuration path — on this page or anywhere
 * else — to send anyone to instead.
 */
function notConfiguredSentence(kind: GatewayKind): string {
  switch (kind) {
    case "telegram":
      return "The hosted Telegram bot isn't set up on this deployment.";
    case "discord":
      return "The hosted Discord app isn't set up on this deployment.";
    case "slack":
      return "The hosted Slack app isn't set up on this deployment.";
    case "imessage":
    case "whatsapp":
      // Unreachable — see connectCtaLabel's identical comment above.
      return "";
  }
}

// --------------------------------------------------------------------------- //
// The four card states — exactly one per gateway, mutually exclusive by
// construction (a single if/else chain producing one tagged object), driven
// entirely by `GatewayView` (brief §5):
//   1. planned        — imessage/whatsapp: nothing is checked past this.
//   2. connected       — status === "connected": may or may not still have an
//                        openUrl (discord/slack never do; telegram won't if
//                        its env got unset after the identity linked — see
//                        `GatewayView.openUrl`'s doc-comment). NEVER
//                        `actionUrl` here — that's an INSTALL url for
//                        discord/slack, not a way back into the conversation
//                        (whole-branch review fix 1).
//   3. available        — not connected, but actionUrl is set: the primary CTA.
//   4. not-configured  — not connected, no actionUrl: env isn't set up.
// --------------------------------------------------------------------------- //
type GatewayCardState =
  | { kind: "planned" }
  | { kind: "connected"; openUrl: string | null }
  | { kind: "available"; actionUrl: string }
  | { kind: "not-configured" };

function resolveCardState(gateway: GatewayView): GatewayCardState {
  // `planned` is tested FIRST, and that ordering leans on an invariant that
  // lives in another file: `projectGateways` only ever sets
  // `status: "connected"` for an `available` kind, so a planned gateway with a
  // stray chat identity can't reach the connected branch. `GatewayView`'s type
  // doesn't encode that, so if you change the projection in
  // `gateway-helpers.ts`, re-check this chain.
  if (gateway.availability === "planned") return { kind: "planned" };
  if (gateway.status === "connected") {
    return { kind: "connected", openUrl: gateway.openUrl };
  }
  if (gateway.actionUrl) {
    return { kind: "available", actionUrl: gateway.actionUrl };
  }
  return { kind: "not-configured" };
}

// --------------------------------------------------------------------------- //
// One gateway card. Always fully visible — title, description, and the one
// action for its state, all rendered on load. No button, disclosure, or
// expand affordance ever hides anything here (brief §4).
// --------------------------------------------------------------------------- //
function GatewayCard({ gateway }: { gateway: GatewayView }) {
  const state = resolveCardState(gateway);

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-[var(--gray-05)] bg-[var(--gray-01)] p-3">
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--gray-05)] bg-[var(--gray-03)]">
          <GatewayIcon kind={gateway.kind} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-[var(--gray-12)]">
              {gateway.label}
            </span>
            {state.kind === "connected" && (
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--green-11)]"
                aria-hidden="true"
              />
            )}
          </div>
        </div>
        {state.kind === "planned" && (
          <span className="inline-flex shrink-0 items-center rounded-sm border border-[var(--yellow-09)]/30 bg-[var(--yellow-09)]/15 px-1.5 py-0.5 text-xs font-medium text-[var(--yellow-11)]">
            Coming
          </span>
        )}
      </div>

      <p className="text-xs leading-relaxed text-[var(--gray-09)]">
        {gateway.description}
      </p>

      {state.kind === "connected" && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-[var(--gray-10)]">
            {linkedIdentitiesLine(
              gateway.linkedIdentities.map((i) => i.displayName)
            )}
          </p>
          {state.openUrl && (
            <a
              href={state.openUrl}
              target="_blank"
              rel="noreferrer"
              className="self-start text-xs text-[var(--blue-11-alt)] hover:underline"
            >
              Open {gateway.label}
            </a>
          )}
        </div>
      )}

      {state.kind === "available" && (
        <a
          href={state.actionUrl}
          target="_blank"
          rel="noreferrer"
          className="flex h-8 w-full items-center justify-center rounded bg-[var(--brand-accent)] px-3 text-xs font-bold text-black transition-colors hover:opacity-90"
        >
          {connectCtaLabel(gateway.kind)}
        </a>
      )}

      {state.kind === "not-configured" && (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-[var(--gray-10)]">Not set up yet</p>
          <p className="text-xs leading-relaxed text-[var(--gray-09)]">
            {notConfiguredSentence(gateway.kind)}
          </p>
          {/* Telegram only: the self-host bring-your-own-bot escape hatch
              (whole-branch review fix 2) — Discord/Slack have no self-host
              path, only the hosted shared app, so there's no equivalent link
              for them. */}
          {gateway.kind === "telegram" && (
            <a
              href={SELF_HOST_TELEGRAM_DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="self-start text-xs text-[var(--blue-11)] hover:underline"
            >
              Bring your own bot
            </a>
          )}
        </div>
      )}
    </div>
  );
}

export function GatewaysPanel({ workspaceId }: { workspaceId: string }) {
  const [gateways, setGateways] = useState<GatewayView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchGateways = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/gateways`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `HTTP ${res.status}`
        );
      }
      const json = (await res.json()) as { gateways: GatewayView[] };
      setGateways(json.gateways ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load gateways");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchGateways();
  }, [fetchGateways]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center">
        <button
          onClick={fetchGateways}
          className="ml-auto h-8 px-3 rounded bg-[var(--gray-03)] border border-[var(--gray-06)] text-sm text-[var(--gray-12)] hover:border-[var(--gray-08)] transition-colors"
        >
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 items-start gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="h-28 rounded-lg border border-[var(--gray-05)] bg-[var(--gray-01)] animate-pulse"
            />
          ))}
        </div>
      ) : error ? (
        <div className="rounded border border-[var(--red-09)]/30 bg-[var(--red-09)]/10 px-3 py-8 text-center text-sm text-[var(--red-11)]">
          {error}
        </div>
      ) : gateways.length === 0 ? (
        <div className="rounded border border-[var(--gray-05)] px-3 py-8 text-center text-sm text-[var(--gray-09)]">
          No gateways available.
        </div>
      ) : (
        // Catalog order, as returned by the T2 route — never re-sorted.
        //
        // No `items-start`: grid's default `stretch` is what keeps every card
        // in a row the same height. These cards carry different amounts of
        // content — a linked one adds an "Open …" link, an unconfigured one
        // adds two lines of explanation — so pinning them to their own content
        // height left the row visibly ragged.
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {gateways.map((gateway) => (
            <GatewayCard key={gateway.kind} gateway={gateway} />
          ))}
        </div>
      )}
    </div>
  );
}

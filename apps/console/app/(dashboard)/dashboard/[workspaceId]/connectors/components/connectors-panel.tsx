"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Radio, AlertCircle, CheckCircle2, X } from "lucide-react";
import { ConnectorStatusBadge } from "./connector-status-badge";
import { ConnectorSheet } from "./connector-sheet";
import { KIND_ICON, KIND_TINT } from "./connector-icon-map";
import {
  activeHeartbeatConnectors,
  CONNECTOR_TYPE_META,
  shouldShowOauthSetupHint,
  type ConnectorKind,
  type ConnectorType,
  type ConnectorView,
} from "./connector-helpers";
import { OAUTH_ERROR_REASONS, type OauthErrorReason } from "../../../../../../lib/oauth/redirect";

/**
 * The Connectors page (Connectors UX v2, Track A — the owner's "the design
 * we have in the console is not consistent, the height can change, so
 * poor"). Previously every card was an accordion: a connected card opened
 * INLINE by default and expanded in place, so a grid row could hold one
 * tall expanded card beside short collapsed ones — height varied per row,
 * per section, per connected/disconnected state.
 *
 * Now every provider, in every section (issue sources / MCP /
 * observability), renders as the SAME fixed-height `ConnectorTile` — brand
 * icon, name, one-line description, status pill, nothing else. No inline
 * expansion means no tile can ever be taller than its neighbors; height
 * variance is impossible by construction, not by convention. Clicking a
 * tile (a `planned` one is inert) opens `ConnectorSheet`, a single overlay
 * instance mounted once here and reused for whichever connector is open —
 * every provider's connect form, live-verify errors, connected details, and
 * heartbeat controls render into that ONE surface instead of each card's
 * own expand region.
 *
 * `projectConnectors` / the catalog (`connector-helpers.ts`) are untouched —
 * this file is a render-layer restructure over the exact same data shape.
 */

const SECTION_ORDER: ConnectorType[] = ["issue-source", "mcp", "observability"];

// --------------------------------------------------------------------------- //
// OAuth connect result banner (W3-T2 fix round, review Finding #1) — reads
// the OAuth callback route's own `?connected=<provider>` /
// `?oauth_error=<reason>` redirect params (`lib/oauth/redirect.ts`, T1) and
// surfaces them as a dismissible banner. T1 shipped the redirect but NOTHING
// ever read these params — every prior connect attempt (success or any of
// the six original failure reasons) landed back on this page with zero
// visible feedback beyond the connector's own state quietly changing. Closed
// here rather than left unsurfaced, specifically because the NEW
// `project_not_granted` reason (this fix round) needs a legible "what do I
// do now" — the coordinator's own ask for this reason's "sheet copy" is
// interpreted here as this banner: the sheet itself is closed by the time
// the browser lands back on this page (it navigated away to the vendor's
// consent screen), so there is no open sheet to caption at redirect time.
// Every reason (all seven, generically off the closed `OAUTH_ERROR_REASONS`
// set — never hand-listing them a second time) gets a short, calm sentence;
// unrecognized/missing params render nothing.
// --------------------------------------------------------------------------- //

const OAUTH_ERROR_MESSAGES: Record<OauthErrorReason, string> = {
  state_invalid:
    "That connect link expired, was already used, or didn't match your session — click Connect again to start a fresh one.",
  provider_unknown: "That connector isn't recognized on this deployment.",
  provider_unconfigured:
    "OAuth isn't set up for this connector on this deployment yet — use an API token instead.",
  denied: "The request was declined on the provider's own consent screen — nothing was connected.",
  exchange_failed: "Couldn't complete the connection with the provider — try Connect again in a moment.",
  store_failed: "The connection succeeded but couldn't be saved here — try Connect again.",
  project_not_granted:
    "The project(s) granted during authorization don't match what's configured here — click Connect again and select the matching project, or update the project ID field below.",
};

function capitalize(value: string): string {
  return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/** The `useSearchParams()`-reading piece, isolated so it can sit inside its
 * own `<Suspense>` boundary (Next.js App Router requirement for any Client
 * Component calling `useSearchParams()`) without wrapping the whole panel. */
function OauthResultBanner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [dismissed, setDismissed] = useState(false);

  const connectedProvider = searchParams.get("connected");
  const errorParam = searchParams.get("oauth_error");
  const errorReason: OauthErrorReason | null =
    errorParam !== null && (OAUTH_ERROR_REASONS as readonly string[]).includes(errorParam)
      ? (errorParam as OauthErrorReason)
      : null;

  // Strips the query params on dismiss so a later refresh of this same page
  // doesn't re-show a stale result.
  const dismiss = useCallback(() => {
    setDismissed(true);
    router.replace(pathname);
  }, [router, pathname]);

  if (dismissed || (!connectedProvider && !errorReason)) return null;

  return (
    <div
      role="status"
      className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs leading-relaxed ${
        errorReason
          ? "border-[var(--red-09)]/30 bg-[var(--red-09)]/10 text-[var(--red-11)]"
          : "border-[var(--green-09)]/30 bg-[var(--green-09)]/10 text-[var(--green-11)]"
      }`}
    >
      {errorReason ? (
        <AlertCircle size={14} className="mt-0.5 shrink-0" />
      ) : (
        <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
      )}
      <p className="flex-1">
        {errorReason ? OAUTH_ERROR_MESSAGES[errorReason] : `${capitalize(connectedProvider!)} connected.`}
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded p-0.5 opacity-70 transition-opacity hover:opacity-100"
      >
        <X size={13} />
      </button>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// A fixed-height tile — every provider, in every section, is dimensionally
// identical. `disabled` (planned) tiles are inert and visually muted; every
// other tile opens the connect/manage sheet on click.
//
// W3-T8 (owner-visible OAuth setup state, `.superpowers/sdd/plan-oauth.md`)
// adds one small, quiet "Setup" tag alongside the existing status badge —
// see `shouldShowOauthSetupHint`'s own doc-comment (`connector-helpers.ts`)
// for the exact gate (oauth-capable for THIS caller, not yet ready, not
// already connected). It rides in the SAME bottom row as the status badge
// rather than adding a new row, so the tile's fixed `h-28` (the #1545
// invariant this redesign exists to guarantee — see the module doc-comment
// above) never shifts: this is a width change within an existing row, not
// a height change. Exported — unlike this file's other internal-only
// pieces (`ConnectorSection`, `HeartbeatStatusHeader`, not exported) —
// specifically so `connectors-panel.test.ts` can call it directly and walk
// its returned element tree (this repo's vitest environment is "node", no
// @testing-library/react/jsdom —
// see that test file's own doc-comment); `ConnectorTile` itself has no
// hooks, so this direct-call technique is safe, mirroring
// `digest-panel.test.ts`'s identical `PlanCardBlock`/`PlanCardEmpty`
// precedent.
// --------------------------------------------------------------------------- //
export function ConnectorTile({
  connector,
  onOpen,
}: {
  connector: ConnectorView;
  onOpen: (kind: ConnectorKind) => void;
}) {
  const Icon = KIND_ICON[connector.kind];
  const isPlanned = connector.availability === "planned";

  return (
    <button
      type="button"
      onClick={() => onOpen(connector.kind)}
      disabled={isPlanned}
      aria-haspopup="dialog"
      title={
        isPlanned
          ? `${connector.label} — coming soon`
          : `Manage ${connector.label}`
      }
      className={`flex h-28 w-full flex-col justify-between rounded-lg border p-3 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-text)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--gray-01)] ${
        isPlanned
          ? "cursor-not-allowed border-[var(--gray-04)] bg-[var(--gray-01)] opacity-60"
          : "cursor-pointer border-[var(--gray-05)] bg-[var(--gray-01)] hover:border-[var(--gray-08)]"
      }`}
    >
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--gray-05)] bg-[var(--gray-03)]">
          <Icon size={17} className={KIND_TINT[connector.kind]} />
        </div>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--gray-12)]">
          {connector.label}
        </span>
      </div>
      <p className="truncate text-xs text-[var(--gray-09)]">
        {connector.description}
      </p>
      <div className="flex items-center gap-1.5 self-start">
        <ConnectorStatusBadge
          status={connector.status}
          availability={connector.availability}
        />
        {shouldShowOauthSetupHint(connector) && (
          <span
            title="One-click connect is available once this deployment sets a few environment variables"
            className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-xs font-medium bg-[var(--blue-09)]/10 text-[var(--blue-11-alt)] border border-[var(--blue-09)]/25"
          >
            Setup
          </span>
        )}
      </div>
    </button>
  );
}

// --------------------------------------------------------------------------- //
// Heartbeat status header (#816 folded in). Unchanged by this redesign.
// --------------------------------------------------------------------------- //
function HeartbeatStatusHeader({ connectors }: { connectors: ConnectorView[] }) {
  const active = activeHeartbeatConnectors(connectors);
  return (
    <div className="rounded-lg border border-[var(--gray-05)] bg-[var(--gray-02)] p-3">
      <div className="flex items-center gap-1.5">
        <Radio size={14} className="text-[var(--gray-10)]" />
        <span className="text-xs font-semibold text-[var(--gray-12)]">
          Heartbeat
        </span>
        <span
          className={`ml-auto inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs font-medium ${
            active.length > 0
              ? "bg-[var(--green-09)]/15 text-[var(--green-11)]"
              : "bg-[var(--gray-04)] text-[var(--gray-10)]"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              active.length > 0 ? "bg-[var(--green-11)]" : "bg-[var(--gray-08)]"
            }`}
          />
          {active.length > 0
            ? `${active.length} active`
            : "No active connectors"}
        </span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-[var(--gray-09)]">
        {active.length > 0 ? (
          <>
            The autonomous loop polls{" "}
            <span className="text-[var(--gray-11)]">
              {active.map((c) => c.label).join(", ")}
            </span>{" "}
            for labeled issues and admits them into the Issue Queue.
          </>
        ) : (
          <>
            No connector is currently driving the heartbeat. Connect and enable an
            ingest connector below to start the autonomous loop.
          </>
        )}
      </p>
      <p className="mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-[var(--gray-09)]">
        <AlertCircle size={13} className="mt-0.5 shrink-0" />
        The daemon only runs once all prerequisite capabilities are present
        (agentrail/heartbeat/gate.py). Enabling here records operator intent.
      </p>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// One catalog-type section (Issue sources / MCP / Observability) of tiles —
// same heading + blurb as before the redesign, uniform tiles instead of
// accordion cards.
// --------------------------------------------------------------------------- //
function ConnectorSection({
  type,
  connectors,
  onOpen,
}: {
  type: ConnectorType;
  connectors: ConnectorView[];
  onOpen: (kind: ConnectorKind) => void;
}) {
  if (connectors.length === 0) return null;
  const meta = CONNECTOR_TYPE_META[type];
  const connectedCount = connectors.filter(
    (c) => c.status === "connected"
  ).length;
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-baseline gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--gray-11)]">
          {meta.label}
        </h2>
        <span className="text-xs text-[var(--gray-08)]">
          {connectedCount}/{connectors.length} connected
        </span>
      </div>
      <p className="-mt-1 text-xs leading-relaxed text-[var(--gray-09)]">
        {meta.description}
      </p>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {connectors.map((c) => (
          <ConnectorTile key={c.kind} connector={c} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

export function ConnectorsPanel({ workspaceId }: { workspaceId: string }) {
  const [connectors, setConnectors] = useState<ConnectorView[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The open sheet is tracked by KIND, not by holding the ConnectorView
  // object itself — `connectors` gets replaced wholesale on every refetch
  // (new object identities), so deriving `openConnector` below always shows
  // fresh data (e.g. a just-stored secret's "Connected" state) without any
  // manual re-sync after `onChanged` fires.
  const [openKind, setOpenKind] = useState<ConnectorKind | null>(null);

  const fetchConnectors = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/connectors`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `HTTP ${res.status}`
        );
      }
      const json = (await res.json()) as {
        connectors: ConnectorView[];
        canManage?: boolean;
      };
      setConnectors(json.connectors ?? []);
      setCanManage(Boolean(json.canManage));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load connectors");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchConnectors();
  }, [fetchConnectors]);

  const openConnector = connectors.find((c) => c.kind === openKind) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <Suspense fallback={null}>
        <OauthResultBanner />
      </Suspense>

      {!loading && !error && connectors.length > 0 && (
        <HeartbeatStatusHeader connectors={connectors} />
      )}

      <div className="flex items-center">
        <button
          onClick={fetchConnectors}
          className="ml-auto h-8 px-3 rounded bg-[var(--gray-03)] border border-[var(--gray-06)] text-sm text-[var(--gray-12)] hover:border-[var(--gray-08)] transition-colors"
        >
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
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
      ) : connectors.length === 0 ? (
        <div className="rounded border border-[var(--gray-05)] px-3 py-8 text-center text-sm text-[var(--gray-09)]">
          No connectors available.
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {SECTION_ORDER.map((type) => (
            <ConnectorSection
              key={type}
              type={type}
              connectors={connectors.filter((c) => c.type === type)}
              onOpen={setOpenKind}
            />
          ))}
        </div>
      )}

      <ConnectorSheet
        connector={openConnector}
        workspaceId={workspaceId}
        canManage={canManage}
        onChanged={fetchConnectors}
        onClose={() => setOpenKind(null)}
      />
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { Radio, AlertCircle } from "lucide-react";
import { ConnectorStatusBadge } from "./connector-status-badge";
import { ConnectorSheet } from "./connector-sheet";
import { KIND_ICON, KIND_TINT } from "./connector-icon-map";
import {
  activeHeartbeatConnectors,
  CONNECTOR_TYPE_META,
  type ConnectorKind,
  type ConnectorType,
  type ConnectorView,
} from "./connector-helpers";

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
// A fixed-height tile — every provider, in every section, is dimensionally
// identical. `disabled` (planned) tiles are inert and visually muted; every
// other tile opens the connect/manage sheet on click.
// --------------------------------------------------------------------------- //
function ConnectorTile({
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
      <div className="self-start">
        <ConnectorStatusBadge
          status={connector.status}
          availability={connector.availability}
        />
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

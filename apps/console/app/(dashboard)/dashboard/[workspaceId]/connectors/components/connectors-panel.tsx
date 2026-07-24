"use client";

import { useCallback, useEffect, useState, type ComponentType } from "react";
import {
  Radio,
  AlertCircle,
  ChevronDown,
  ExternalLink,
  CheckCircle2,
} from "lucide-react";
import { ConnectorStatusBadge } from "./connector-status-badge";
import {
  GithubBrand,
  LinearBrand,
  FigmaBrand,
  Context7Brand,
  DiscordBrand,
  SlackBrand,
  TelegramBrand,
  type BrandIconProps,
} from "./brand-icons";
import {
  activeHeartbeatConnectors,
  capabilitySummary,
  CONNECTOR_TYPE_META,
  validateConnectorCredential,
  type ConnectorKind,
  type ConnectorType,
  type ConnectorView,
} from "./connector-helpers";
// Relative (not @/…) because both targets live outside app/ or src/, the only
// roots the @/* alias covers — mirrors how channel-step-helpers.ts itself
// imports lib/telegram-bot.
import {
  resolveHostedBotUsername,
  telegramDeepLink,
} from "../../../../../../lib/telegram-bot";
import { SELF_HOST_TELEGRAM_DOCS_URL } from "../../../../setup/components/channel-step-helpers";

/** Brand glyph per connector kind (lucide carries no logos — see brand-icons). */
const KIND_ICON: Record<ConnectorKind, ComponentType<BrandIconProps>> = {
  github: GithubBrand,
  linear: LinearBrand,
  figma: FigmaBrand,
  context7: Context7Brand,
  discord: DiscordBrand,
  slack: SlackBrand,
  telegram: TelegramBrand,
};

/** A subtle brand tint per kind, used on the icon chip so cards stay scannable. */
const KIND_TINT: Record<ConnectorKind, string> = {
  github: "text-[var(--gray-12)]",
  linear: "text-[#5e6ad2]",
  figma: "text-[#f24e1e]",
  context7: "text-[var(--gray-11)]",
  discord: "text-[#5865f2]",
  slack: "text-[#36c5f0]",
  telegram: "text-[#26a5e4]",
};

const SECTION_ORDER: ConnectorType[] = ["issue-source", "mcp", "channel"];

// --------------------------------------------------------------------------- //
// Trigger controls (#816) — folded into each connected ingest connector card.
// --------------------------------------------------------------------------- //
function TriggerControls({
  connector,
  workspaceId,
  canManage,
  onChanged,
}: {
  connector: ConnectorView;
  workspaceId: string;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [label, setLabel] = useState(connector.triggerLabel);
  const [interval, setIntervalValue] = useState(
    String(connector.pollIntervalSeconds)
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const dirty =
    label.trim() !== connector.triggerLabel ||
    Number(interval) !== connector.pollIntervalSeconds;

  const put = useCallback(
    async (patch: {
      enabled?: boolean;
      triggerLabel?: string;
      pollIntervalSeconds?: number;
    }) => {
      setSaving(true);
      setErr(null);
      try {
        const res = await fetch(`/api/v1/workspaces/${workspaceId}/connectors`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: connector.kind, ...patch }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ?? `HTTP ${res.status}`
          );
        }
        onChanged();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Failed to save");
      } finally {
        setSaving(false);
      }
    },
    [workspaceId, connector.kind, onChanged]
  );

  if (!connector.capabilities.ingest) return null;

  return (
    <div className="mt-3 flex flex-col gap-2.5 border-t border-[var(--gray-04)] pt-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Radio size={12} className="text-[var(--gray-09)]" />
          <span className="text-xs font-medium text-[var(--gray-11)]">
            Heartbeat trigger
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={connector.enabled}
          aria-label="Toggle heartbeat for this connector"
          disabled={!canManage || saving}
          onClick={() => put({ enabled: !connector.enabled })}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
            connector.enabled ? "bg-[var(--green-09)]" : "bg-[var(--gray-06)]"
          }`}
        >
          <span
            className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
              connector.enabled ? "translate-x-4" : "translate-x-0"
            }`}
          />
        </button>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          put({
            triggerLabel: label.trim(),
            pollIntervalSeconds: Number(interval),
          });
        }}
        className="flex flex-col gap-2"
      >
        <div className="flex items-center gap-2">
          <input
            aria-label="Trigger label"
            type="text"
            maxLength={50}
            value={label}
            disabled={!canManage}
            placeholder="ready-for-agent"
            onChange={(e) => setLabel(e.target.value)}
            className="h-7 flex-1 rounded border border-[var(--gray-05)] bg-[var(--gray-01)] px-2 font-mono text-xs text-[var(--gray-12)] placeholder:text-[var(--gray-07)] outline-none focus:border-[var(--gray-08)] disabled:opacity-50"
          />
          <input
            aria-label="Poll interval (seconds)"
            type="number"
            min={10}
            max={86400}
            step={1}
            value={interval}
            disabled={!canManage}
            title="Poll interval (seconds, 10–86400)"
            onChange={(e) => setIntervalValue(e.target.value)}
            className="h-7 w-20 rounded border border-[var(--gray-05)] bg-[var(--gray-01)] px-2 font-mono text-xs text-[var(--gray-12)] outline-none focus:border-[var(--gray-08)] disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!canManage || saving || !dirty || !label.trim()}
            className="h-7 shrink-0 rounded border border-[var(--gray-06)] bg-[var(--gray-03)] px-3 text-xs font-medium text-[var(--gray-12)] transition-colors hover:border-[var(--gray-08)] disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
        {err && <p className="text-xs text-[var(--red-11)]">{err}</p>}
      </form>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// "How to set up" — collapsible per-provider steps + docs link.
// --------------------------------------------------------------------------- //
function SetupHelp({ connector }: { connector: ConnectorView }) {
  const [open, setOpen] = useState(false);
  if (!connector.connect) return null;
  const { setupSteps, helpUrl } = connector.connect;
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 self-start text-xs text-[var(--gray-09)] hover:text-[var(--gray-11)]"
      >
        <ChevronDown
          size={12}
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        />
        How to set up {connector.label}
      </button>
      {open && (
        <div className="flex flex-col gap-1.5 rounded border border-[var(--gray-04)] bg-[var(--gray-02)] p-2.5">
          <ol className="ml-3.5 list-decimal space-y-1 text-xs leading-relaxed text-[var(--gray-10)]">
            {setupSteps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          <a
            href={helpUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 self-start text-xs text-[var(--blue-11-alt)] hover:underline"
          >
            Open {connector.label} docs
            <ExternalLink size={11} />
          </a>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Secret connector management — MCP-key connectors only now (linear/figma/
// context7). Posts the credential to the write-only /connectors/secret route;
// the value is never read back. Channel kinds (discord/slack/telegram) never
// reach this component post-cutover — see ChannelManage below.
// --------------------------------------------------------------------------- //
function SecretManage({
  connector,
  workspaceId,
  canManage,
  onChanged,
}: {
  connector: ConnectorView;
  workspaceId: string;
  canManage: boolean;
  onChanged: () => void;
}) {
  const isConnected = connector.status === "connected";
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const meta = connector.connect;

  const save = useCallback(
    async (body: { secret: string | null }) => {
      setSaving(true);
      setErr(null);
      try {
        const res = await fetch(
          `/api/v1/workspaces/${workspaceId}/connectors/secret`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provider: connector.kind, ...body }),
          }
        );
        if (!res.ok) {
          const b = await res.json().catch(() => ({}));
          throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`);
        }
        setSecret("");
        onChanged();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Failed to save");
      } finally {
        setSaving(false);
      }
    },
    [workspaceId, connector.kind, onChanged]
  );

  if (isConnected) {
    return (
      <div className="flex flex-col gap-2">
        <p className="flex items-center gap-1.5 text-xs text-[var(--gray-10)]">
          <CheckCircle2 size={13} className="text-[var(--green-11)]" />
          {meta?.credentialLabel ?? "Credential"} stored
          {connector.target ? (
            <code className="font-mono text-[var(--gray-11)]">
              · {connector.target}
            </code>
          ) : null}
        </p>
        <button
          onClick={() => save({ secret: null })}
          disabled={!canManage || saving}
          className="h-7 w-full rounded border border-[var(--gray-05)] bg-[var(--gray-02)] text-xs font-medium text-[var(--gray-11)] hover:border-[var(--gray-08)] transition-colors disabled:opacity-50"
        >
          {saving ? "Disconnecting…" : "Disconnect"}
        </button>
        {err && <p className="text-xs text-[var(--red-11)]">{err}</p>}
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const check = validateConnectorCredential(connector.kind, secret);
        if (!check.ok) {
          setErr(check.error);
          return;
        }
        save({ secret: secret.trim() });
      }}
      className="flex flex-col gap-2"
    >
      <input
        aria-label={meta?.credentialLabel ?? "Credential"}
        type="password"
        autoComplete="off"
        placeholder={meta?.credentialPlaceholder}
        value={secret}
        disabled={!canManage}
        onChange={(e) => setSecret(e.target.value)}
        className="h-8 w-full rounded border border-[var(--gray-05)] bg-[var(--gray-01)] px-2 font-mono text-xs text-[var(--gray-12)] placeholder:text-[var(--gray-07)] outline-none focus:border-[var(--gray-08)] disabled:opacity-50"
      />
      {meta?.credentialHint && (
        <p className="text-xs text-[var(--gray-08)]">{meta.credentialHint}</p>
      )}
      <button
        type="submit"
        disabled={!canManage || saving || secret.trim().length === 0}
        className="h-8 w-full rounded border border-[var(--gray-06)] bg-[var(--gray-03)] text-xs font-medium text-[var(--gray-12)] hover:border-[var(--gray-08)] transition-colors disabled:opacity-50"
      >
        {saving ? "Connecting…" : "Connect"}
      </button>
      {err && <p className="text-xs text-[var(--red-11)]">{err}</p>}
      <SetupHelp connector={connector} />
    </form>
  );
}

// --------------------------------------------------------------------------- //
// Channel management — Discord/Slack/Telegram are Jace-native chat: there is
// no credential to paste and nothing to disconnect here (CONTEXT.md / the
// helpers' module doc). Telegram (the only `available` channel kind today)
// resolves the hosted shared bot's deep link when the env is set; self-host
// deploys get a quiet docs link instead of a dead button. Discord/Slack
// (`planned`) render nothing beyond the card's own description + status
// chip — never a fake affordance.
// --------------------------------------------------------------------------- //

/**
 * One line summarizing a channel's linked identities. Simplest honest form:
 * a linked identity can have a null displayName (chat_identities row with no
 * profile name), so when NONE of them have a name there's nothing to list —
 * just the count. Otherwise list the names we do have and fold the nameless
 * ones into a trailing "+N" rather than pad the list with placeholders.
 */
function linkedIdentitiesLine(
  identities: ConnectorView["linkedIdentities"]
): string {
  const names = identities
    .map((i) => i.displayName)
    .filter((name): name is string => name !== null);
  if (names.length === 0) return `${identities.length} linked`;
  const unnamed = identities.length - names.length;
  const joined = names.join(", ");
  return unnamed > 0 ? `Linked: ${joined} +${unnamed}` : `Linked: ${joined}`;
}

function ChannelManage({ connector }: { connector: ConnectorView }) {
  // Discord/Slack: no adapter yet, so no credential to collect and no
  // affordance to dangle — the card's status chip already reads "Coming".
  if (connector.availability === "planned") return null;

  const hostedBotUsername = resolveHostedBotUsername(
    process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME
  );

  if (connector.status === "connected") {
    return (
      <div className="flex flex-col gap-1.5">
        <p className="flex items-center gap-1.5 text-xs text-[var(--gray-10)]">
          <CheckCircle2 size={13} className="text-[var(--green-11)]" />
          {linkedIdentitiesLine(connector.linkedIdentities)}
        </p>
        {hostedBotUsername && (
          <a
            href={telegramDeepLink(hostedBotUsername)}
            target="_blank"
            rel="noreferrer"
            className="self-start text-xs text-[var(--blue-11-alt)] hover:underline"
          >
            Open Telegram
          </a>
        )}
      </div>
    );
  }

  if (hostedBotUsername) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs leading-relaxed text-[var(--gray-09)]">
          Message the bot once — that chat becomes your channel.
        </p>
        {/* font-bold accent fill — same primary-CTA convention as the setup
            wizard's hosted branch (channel-step.tsx). */}
        <a
          href={telegramDeepLink(hostedBotUsername)}
          target="_blank"
          rel="noreferrer"
          className="flex h-8 w-full items-center justify-center rounded bg-[var(--brand-accent)] px-3 text-xs font-bold text-black transition-colors hover:opacity-90"
        >
          Message @{hostedBotUsername} on Telegram
        </a>
      </div>
    );
  }

  return (
    <p className="text-xs text-[var(--gray-09)]">
      Self-hosting?{" "}
      <a
        href={SELF_HOST_TELEGRAM_DOCS_URL}
        target="_blank"
        rel="noreferrer"
        className="text-[var(--blue-11-alt)] hover:underline"
      >
        Bring your own bot
      </a>
    </p>
  );
}

// --------------------------------------------------------------------------- //
// GitHub — a GitHub App installation, not a pasted credential: the button
// round-trips to mint a single-use install link, then sends the browser to
// GitHub's own install screen. (spec 2026-07-24-jace-github-app-identity §5)
// --------------------------------------------------------------------------- //
function GithubManage({
  connector,
  workspaceId,
}: {
  connector: ConnectorView;
  workspaceId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/workspaces/${workspaceId}/connectors/github/install-link`,
        { method: "POST" }
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not start the install");
      window.location.href = body.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the install");
      setBusy(false);
    }
  }

  // Install button + error, shared by the two states that need it (not
  // connected at all, and connected-via-repos-only with no App installed) —
  // one handler, rendered from both branches instead of duplicated.
  const installButton = (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={connect}
        disabled={busy}
        className="h-8 w-full rounded border border-[var(--gray-06)] bg-[var(--gray-03)] text-xs font-medium text-[var(--gray-12)] hover:border-[var(--gray-08)] transition-colors disabled:opacity-50"
      >
        {busy ? "Connecting…" : "Connect GitHub"}
      </button>
      {error && <p className="text-xs text-[var(--red-11)]">{error}</p>}
    </div>
  );

  if (connector.status === "connected" && connector.appInstalled) {
    return (
      <p className="text-xs leading-relaxed text-[var(--gray-09)]">
        Jace is installed on your GitHub. Issues labeled{" "}
        <code className="font-mono text-[var(--gray-11)]">
          {connector.ingestLabel}
        </code>{" "}
        are ingested into the Issue Queue; run results post back on the issue.
      </p>
    );
  }

  if (connector.status === "connected" && !connector.appInstalled) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs leading-relaxed text-[var(--gray-09)]">
          Repos are linked from the legacy flow, but the Jace GitHub App
          isn&apos;t installed yet — install it so Jace can review, push, and
          open PRs as itself.
        </p>
        {installButton}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs leading-relaxed text-[var(--gray-09)]">
        Install the Jace GitHub App to let Jace review, push, and open PRs on
        the repos you pick — every action shows as Jace, not you.
      </p>
      {installButton}
    </div>
  );
}

// --------------------------------------------------------------------------- //
// A compact connector card. Header is always visible; the manage body expands.
// --------------------------------------------------------------------------- //
function ConnectorCard({
  connector,
  workspaceId,
  canManage,
  onChanged,
}: {
  connector: ConnectorView;
  workspaceId: string;
  canManage: boolean;
  onChanged: () => void;
}) {
  const Icon = KIND_ICON[connector.kind];
  const isConnected = connector.status === "connected";
  // Connected cards open by default (so the trigger/disconnect is one glance
  // away); unconnected cards stay collapsed to keep the grid compact.
  const [open, setOpen] = useState(isConnected);

  return (
    <div className="flex flex-col rounded-lg border border-[var(--gray-05)] bg-[var(--gray-01)]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2.5 p-3 text-left"
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--gray-05)] bg-[var(--gray-03)]">
          <Icon size={17} className={KIND_TINT[connector.kind]} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-[var(--gray-12)]">
              {connector.label}
            </span>
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                isConnected ? "bg-[var(--green-11)]" : "bg-[var(--gray-07)]"
              }`}
              aria-hidden="true"
            />
          </div>
          <p className="truncate text-xs text-[var(--gray-09)]">
            {capabilitySummary(connector.capabilities)}
          </p>
        </div>
        <ChevronDown
          size={15}
          className={`shrink-0 text-[var(--gray-09)] transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <div className="flex flex-col gap-3 border-t border-[var(--gray-04)] p-3">
          <div className="flex items-center justify-between gap-2">
            <ConnectorStatusBadge
              status={connector.status}
              availability={connector.availability}
            />
            {connector.target && connector.connectMethod === "oauth" && (
              <code className="truncate font-mono text-xs text-[var(--gray-10)]">
                {connector.target}
              </code>
            )}
          </div>
          <p className="text-xs leading-relaxed text-[var(--gray-09)]">
            {connector.description}
          </p>

          {connector.connectMethod === "oauth" ? (
            <GithubManage connector={connector} workspaceId={workspaceId} />
          ) : connector.type === "channel" ? (
            <ChannelManage connector={connector} />
          ) : (
            <SecretManage
              connector={connector}
              workspaceId={workspaceId}
              canManage={canManage}
              onChanged={onChanged}
            />
          )}

          {isConnected && connector.capabilities.ingest && (
            <TriggerControls
              connector={connector}
              workspaceId={workspaceId}
              canManage={canManage}
              onChanged={onChanged}
            />
          )}
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Heartbeat status header (#816 folded in).
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
// One catalog-type section (Issue sources / MCP / Channels) of compact cards.
// --------------------------------------------------------------------------- //
function ConnectorSection({
  type,
  connectors,
  workspaceId,
  canManage,
  onChanged,
}: {
  type: ConnectorType;
  connectors: ConnectorView[];
  workspaceId: string;
  canManage: boolean;
  onChanged: () => void;
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
      {/* items-start so expanding one card never stretches its row-mates. */}
      <div className="grid grid-cols-1 items-start gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {connectors.map((c) => (
          <ConnectorCard
            key={c.kind}
            connector={c}
            workspaceId={workspaceId}
            canManage={canManage}
            onChanged={onChanged}
          />
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
              className="h-14 rounded-lg border border-[var(--gray-05)] bg-[var(--gray-01)] animate-pulse"
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
              workspaceId={workspaceId}
              canManage={canManage}
              onChanged={fetchConnectors}
            />
          ))}
        </div>
      )}
    </div>
  );
}

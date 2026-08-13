"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  X,
} from "lucide-react";
import { ConnectorStatusBadge } from "./connector-status-badge";
import { KIND_ICON, KIND_TINT } from "./connector-icon-map";
import {
  capabilitySummary,
  shouldShowOauthSetupHint,
  validateConnectorCredential,
  type ConnectorConnectMeta,
  type ConnectorView,
} from "./connector-helpers";

// --------------------------------------------------------------------------- //
// Broker connect button for a `connectMethod: "secret"` provider — distinct
// from `OAuthManage` below, which is GitHub's own OAuth-native install flow.
// Posts to the GENERIC `.../connectors/oauth/link` route
// (provider in the body, not the URL — every OAuth-capable secret-method
// provider shares this one route) and redirects the browser to the
// vendor's own authorize screen on success, mirroring `OAuthManage`'s
// `connect()` shape and button styling exactly (a "Connect X" affordance
// should look identical regardless of which flow mints the redirect).
// --------------------------------------------------------------------------- //
function OauthConnectButton({
  connector,
  workspaceId,
  canManage,
}: {
  connector: ConnectorView;
  workspaceId: string;
  canManage: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/workspaces/${workspaceId}/connectors/oauth/link`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: connector.kind }),
        }
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not start the connection");
      window.location.href = body.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the connection");
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={connect}
        disabled={!canManage || busy}
        className="h-8 w-full rounded border border-[var(--gray-06)] bg-[var(--gray-03)] text-xs font-medium text-[var(--gray-12)] hover:border-[var(--gray-08)] transition-colors disabled:opacity-50"
      >
        {busy ? "Connecting…" : `Connect ${connector.label}`}
      </button>
      {error && <p className="text-xs text-[var(--red-11)]">{error}</p>}
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Setup details are deliberately behind the first Connect action. The user
// starts every connector from the same place, but the broker is honest about
// what happens next: OAuth, an API credential, or a self-hosted endpoint.
// --------------------------------------------------------------------------- //
function ConnectionPathSummary({ connector }: { connector: ConnectorView }) {
  const connection = connector.connection;
  if (!connection) return null;

  const isSelfHosted = connection.supportedDeployments.includes("self-hosted");
  let title: string;
  let detail: string;

  if (connection.mode === "direct-oauth") {
    title = connector.oauthReady ? "Hosted OAuth" : "Hosted OAuth not enabled";
    detail = connector.oauthReady
      ? "Provider consent required."
      : connection.manualFallback
        ? "Provider credentials required."
        : "Administrator setup required.";
  } else if (connection.mode === "remote-mcp-oauth") {
    title = connector.oauthReady
      ? "Hosted MCP · OAuth"
      : connection.manualFallback
        ? "Hosted MCP · credential fallback"
        : "Hosted MCP · OAuth not enabled";
    detail = connector.oauthReady
      ? "Provider consent required."
      : connection.manualFallback
        ? "Provider credentials required."
        : "Administrator setup required.";
  } else {
    title = isSelfHosted ? "Self-hosted endpoint" : "Provider credential";
    detail = isSelfHosted
      ? "Endpoint and credential required."
      : "Credential is encrypted and verified.";
  }

  return (
    <div className="rounded border border-[var(--gray-04)] bg-[var(--gray-02)] px-2.5 py-2">
      <p className="text-xs font-medium text-[var(--gray-11)]">{title}</p>
      <p className="mt-0.5 text-xs leading-relaxed text-[var(--gray-09)]">{detail}</p>
    </div>
  );
}

function SetupHelp({ connector }: { connector: ConnectorView }) {
  const [open, setOpen] = useState(false);
  if (!connector.connect) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1 self-start text-xs text-[var(--gray-09)] hover:text-[var(--gray-11)]"
      >
        <ChevronDown size={12} className={open ? "rotate-180" : ""} />
        How to connect {connector.label}
      </button>
      {open && (
        <div className="flex flex-col gap-1.5 rounded border border-[var(--gray-04)] bg-[var(--gray-02)] p-2.5">
          <ol className="ml-3.5 list-decimal space-y-1 text-xs leading-relaxed text-[var(--gray-10)]">
            {connector.connect.setupSteps.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ol>
          <a
            href={connector.connect.helpUrl}
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

function OauthUnavailableNotice({ connector }: { connector: ConnectorView }) {
  const setup = connector.oauthSetup;
  if (!setup || connector.oauthReady || !shouldShowOauthSetupHint(connector)) {
    return null;
  }
  return (
    <div className="rounded border border-[var(--amber-09)]/30 bg-[var(--amber-09)]/10 p-2.5">
      <p className="text-xs font-medium text-[var(--gray-11)]">
        OAuth is not enabled on this deployment
      </p>
      <p className="mt-0.5 text-xs leading-relaxed text-[var(--gray-09)]">
        Configure the provider OAuth app, or use credentials below.
      </p>
      {setup.missingEnv.length > 0 && (
        <p className="mt-1.5 text-xs text-[var(--gray-09)]">
          Missing: {setup.missingEnv.map((name) => (
            <code key={name} className="ml-1 font-mono text-[var(--gray-11)]">
              {name}
            </code>
          ))}
        </p>
      )}
      {connector.connect?.oauthRegistrationUrl && (
        <a
          href={connector.connect.oauthRegistrationUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1.5 inline-flex items-center gap-1 text-xs text-[var(--blue-11-alt)] hover:underline"
        >
          Registration steps
          <ExternalLink size={11} />
        </a>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Secret connector management — the initial action is consistent, but the
// next step follows the provider's actual capability declaration.
// --------------------------------------------------------------------------- //
const NO_SECRET_PARTS: NonNullable<ConnectorConnectMeta["secretParts"]> = [];
const NO_EXTRA_FIELDS: NonNullable<ConnectorConnectMeta["extraConfigFields"]> = [];

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
  const meta = connector.connect;
  const secretParts = meta?.secretParts ?? NO_SECRET_PARTS;
  const extraFields = meta?.extraConfigFields ?? NO_EXTRA_FIELDS;
  const isComposite = secretParts.length > 0;
  const [secret, setSecret] = useState("");
  const [partValues, setPartValues] = useState<string[]>(() => secretParts.map(() => ""));
  const [extraValues, setExtraValues] = useState<Record<string, string>>({});
  const [manualOpen, setManualOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = useCallback(
    async (credential: string | null) => {
      setSaving(true);
      setErr(null);
      try {
        const configEntries = extraFields
          .map((field) => [field.key, (extraValues[field.key] ?? "").trim()] as const)
          .filter(([, value]) => value.length > 0);
        const res = await fetch(`/api/v1/workspaces/${workspaceId}/connectors/secret`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: connector.kind,
            secret: credential,
            ...(credential !== null ? Object.fromEntries(configEntries) : {}),
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
        }
        if (credential !== null && configEntries.length > 0) {
          const configRes = await fetch(`/api/v1/workspaces/${workspaceId}/connectors`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provider: connector.kind, ...Object.fromEntries(configEntries) }),
          });
          if (!configRes.ok) {
            const body = await configRes.json().catch(() => ({}));
            throw new Error((body as { error?: string }).error ?? `HTTP ${configRes.status}`);
          }
        }
        setSecret("");
        setPartValues(secretParts.map(() => ""));
        setExtraValues({});
        onChanged();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Failed to save");
      } finally {
        setSaving(false);
      }
    },
    [workspaceId, connector.kind, extraFields, extraValues, secretParts, onChanged]
  );

  if (isConnected) {
    return (
      <div className="flex flex-col gap-2">
        <p className="flex items-center gap-1.5 text-xs text-[var(--gray-10)]">
          <CheckCircle2 size={13} className="text-[var(--green-11)]" />
          {meta?.credentialLabel ?? "Connection"} connected
          {connector.target ? <code className="font-mono text-[var(--gray-11)]">· {connector.target}</code> : null}
        </p>
        <button
          type="button"
          onClick={() => save(null)}
          disabled={!canManage || saving}
          className="h-7 w-full rounded border border-[var(--gray-05)] bg-[var(--gray-02)] text-xs font-medium text-[var(--gray-11)] hover:border-[var(--gray-08)] transition-colors disabled:opacity-50"
        >
          {saving ? "Disconnecting…" : "Disconnect"}
        </button>
        {err && <p className="text-xs text-[var(--red-11)]">{err}</p>}
      </div>
    );
  }

  const missingRequiredExtra = extraFields.find(
    (field) => field.required !== false && (extraValues[field.key] ?? "").trim().length === 0
  );

  const tokenForm = (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        let credential: string;
        if (isComposite) {
          if (partValues.some((value) => value.trim().length === 0)) {
            setErr("All credential fields are required.");
            return;
          }
          if (partValues.some((value) => value.includes(":"))) {
            setErr('Credential fields must not contain ":".');
            return;
          }
          credential = partValues.map((value) => value.trim()).join(":");
        } else {
          credential = secret.trim();
        }
        const check = validateConnectorCredential(connector.kind, credential);
        if (!check.ok) {
          setErr(check.error);
          return;
        }
        if (missingRequiredExtra) {
          setErr(`${missingRequiredExtra.label} is required.`);
          return;
        }
        save(credential);
      }}
      className="flex flex-col gap-2"
    >
      {isComposite ? secretParts.map((part, index) => (
        <input
          key={part.name}
          aria-label={part.name}
          type="password"
          autoComplete="off"
          placeholder={part.name}
          value={partValues[index] ?? ""}
          disabled={!canManage}
          onChange={(event) => setPartValues((prev) => prev.map((value, i) => i === index ? event.target.value : value))}
          className="h-8 w-full rounded border border-[var(--gray-05)] bg-[var(--gray-01)] px-2 font-mono text-xs text-[var(--gray-12)] placeholder:text-[var(--gray-07)] outline-none focus:border-[var(--gray-08)] disabled:opacity-50"
        />
      )) : (
        <input
          aria-label={meta?.credentialLabel ?? "Credential"}
          type="password"
          autoComplete="off"
          placeholder={meta?.credentialPlaceholder}
          value={secret}
          disabled={!canManage}
          onChange={(event) => setSecret(event.target.value)}
          className="h-8 w-full rounded border border-[var(--gray-05)] bg-[var(--gray-01)] px-2 font-mono text-xs text-[var(--gray-12)] placeholder:text-[var(--gray-07)] outline-none focus:border-[var(--gray-08)] disabled:opacity-50"
        />
      )}
      {meta?.credentialHint && <p className="text-xs text-[var(--gray-08)]">{meta.credentialHint}</p>}
      {extraFields.map((field) => (
        <input
          key={field.key}
          aria-label={field.label}
          type="text"
          autoComplete="off"
          placeholder={field.placeholder}
          value={extraValues[field.key] ?? ""}
          disabled={!canManage}
          onChange={(event) => setExtraValues((prev) => ({ ...prev, [field.key]: event.target.value }))}
          className="h-8 w-full rounded border border-[var(--gray-05)] bg-[var(--gray-01)] px-2 font-mono text-xs text-[var(--gray-12)] placeholder:text-[var(--gray-07)] outline-none focus:border-[var(--gray-08)] disabled:opacity-50"
        />
      ))}
      <button
        type="submit"
        disabled={!canManage || saving || (isComposite ? partValues.some((value) => value.trim().length === 0) : secret.trim().length === 0) || Boolean(missingRequiredExtra)}
        className="h-8 w-full rounded border border-[var(--gray-06)] bg-[var(--gray-03)] text-xs font-medium text-[var(--gray-12)] hover:border-[var(--gray-08)] transition-colors disabled:opacity-50"
      >
        {saving ? "Connecting…" : "Connect"}
      </button>
      {err && <p className="text-xs text-[var(--red-11)]">{err}</p>}
      <SetupHelp connector={connector} />
    </form>
  );

  if (connector.oauthReady) {
    return (
      <div className="flex flex-col gap-2">
        {meta?.oauthHint && <p className="text-xs leading-relaxed text-[var(--gray-09)]">{meta.oauthHint}</p>}
        <OauthConnectButton connector={connector} workspaceId={workspaceId} canManage={canManage} />
        {connector.connection?.manualFallback && (
          manualOpen ? tokenForm : (
            <button type="button" onClick={() => setManualOpen(true)} className="self-start text-xs text-[var(--gray-09)] underline-offset-2 hover:text-[var(--gray-11)] hover:underline">
              Use provider credential instead
            </button>
          )
        )}
      </div>
    );
  }

  if (connector.connection?.manualFallback || connector.connection?.mode === "manual") {
    return manualOpen ? (
      tokenForm
    ) : (
      <div className="flex flex-col gap-2">
        <OauthUnavailableNotice connector={connector} />
        <button
          type="button"
          onClick={() => setManualOpen(true)}
          disabled={!canManage}
          className="h-8 w-full rounded border border-[var(--gray-06)] bg-[var(--gray-03)] text-xs font-medium text-[var(--gray-12)] hover:border-[var(--gray-08)] transition-colors disabled:opacity-50"
        >
          Connect {connector.label}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <OauthUnavailableNotice connector={connector} />
      <p className="text-xs leading-relaxed text-[var(--gray-09)]">
        Not enabled. Ask a workspace administrator.
      </p>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// OAuth connector management — a provider installation, not a pasted
// credential: the button round-trips to mint a single-use install link, then
// sends the browser to the provider's own install screen. GitHub is the only
// `connectMethod: "oauth"` catalog entry today (spec
// 2026-07-24-jace-github-app-identity §5); this component is written against
// `connector.label`/`connector.kind` rather than hardcoded "GitHub" copy for
// its primary action specifically so a follow-up OAuth provider is a
// catalog entry + (if its install flow differs from GitHub App installs) a
// sibling of this component swapped in on ConnectorSheet's own
// `connectMethod === "oauth"` branch — see that component's doc-comment.
// The explanatory paragraphs below stay GitHub-App-specific prose (there is
// only one oauth provider to describe today); only the primary button's
// label is generic.
// --------------------------------------------------------------------------- //
function OAuthManage({
  connector,
  workspaceId,
  canManage,
}: {
  connector: ConnectorView;
  workspaceId: string;
  canManage: boolean;
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
  // one handler, rendered from both branches instead of duplicated. Gated by
  // `canManage` (Connectors UX v2 Track A: the pre-sheet version of this
  // button had no such gate — disclosed in the PR description as a small,
  // deliberate tightening to match the sheet's "non-admins see read-only"
  // contract, which SecretManage already honored).
  const installButton = (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={connect}
        disabled={!canManage || busy}
        className="h-8 w-full rounded border border-[var(--gray-06)] bg-[var(--gray-03)] text-xs font-medium text-[var(--gray-12)] hover:border-[var(--gray-08)] transition-colors disabled:opacity-50"
      >
        {busy ? "Connecting…" : `Connect ${connector.label}`}
      </button>
      {error && <p className="text-xs text-[var(--red-11)]">{error}</p>}
    </div>
  );

  if (connector.status === "connected" && connector.appInstalled) {
    return (
      <p className="text-xs leading-relaxed text-[var(--gray-09)]">
        Repository and PR evidence connected.
      </p>
    );
  }

  if (connector.status === "connected" && !connector.appInstalled) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs leading-relaxed text-[var(--gray-09)]">
          Install the GitHub App for repository and PR updates.
        </p>
        {installButton}
      </div>
    );
  }

  return installButton;
}

// --------------------------------------------------------------------------- //
// The connect/manage overlay (Connectors UX v2, Track A) — the ONE surface
// every provider's connect flow, live-verify errors, and connected details
// render into. Replaces the old per-tile inline accordion
// body, whose expand/collapse was the root cause of the ragged-height grid
// (a connected card opened by default and grew inline, so a row could hold
// one tall card beside short collapsed ones). Mounted ONCE by
// ConnectorsPanel; `connector` is whichever row is currently open (null =
// closed) — every provider, in every section, shares this exact same
// surface shape.
//
// Slides in from the right; reuses the same tokens the codebase's existing
// centered dialogs use for their backdrop/elevation (--shadow-overlay,
// bg-black/60, the --gray-* surface ramp) so it reads as the same design
// language, just a side sheet instead of a centered one.
//
// OAUTH-READY SEAM: the primary action area is driven purely by
// `connector.connectMethod` — `"oauth"` renders <OAuthManage>, `"secret"`
// renders <SecretManage>. This is the one branch a follow-up OAuth provider
// touches; everything else in this component (header, status badge,
// description and capability summary) is already provider-agnostic.
// --------------------------------------------------------------------------- //
export function ConnectorSheet({
  connector,
  workspaceId,
  canManage,
  onChanged,
  onClose,
}: {
  connector: ConnectorView | null;
  workspaceId: string;
  canManage: boolean;
  onChanged: () => void;
  onClose: () => void;
}) {
  // Keeps rendering the last-open connector's content while the panel
  // slides out: `connector` goes null the instant `onClose` fires, but the
  // close transition still runs for ~200ms and would otherwise blank the
  // sheet mid-animation.
  const [shown, setShown] = useState<ConnectorView | null>(null);
  useEffect(() => {
    if (connector) setShown(connector);
  }, [connector]);

  const open = connector !== null;
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Blurs the close button before telling the parent to close, so a
  // still-focused element is never left inside the `aria-hidden` subtree
  // below once `open` flips false on the same render.
  const requestClose = useCallback(() => {
    closeButtonRef.current?.blur();
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    document.addEventListener("keydown", onKey);
    closeButtonRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, requestClose]);

  // Nothing has ever been opened this session — skip rendering the overlay
  // subtree entirely rather than keeping an always-mounted-but-invisible
  // backdrop in the DOM from first paint.
  if (!shown) return null;

  const Icon = KIND_ICON[shown.kind];
  const summary = capabilitySummary(shown.capabilities);

  return (
    <div
      aria-hidden={!open}
      onClick={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
      className={`fixed inset-0 z-50 bg-black/60 transition-opacity duration-200 ease-out motion-reduce:transition-none ${
        open ? "opacity-100" : "pointer-events-none opacity-0"
      }`}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Manage ${shown.label}`}
        onClick={(e) => e.stopPropagation()}
        style={{ boxShadow: "var(--shadow-overlay)" }}
        className={`fixed inset-y-0 right-0 flex h-full w-full max-w-md flex-col border-l border-[var(--gray-05)] bg-[var(--gray-01)] transition-transform duration-200 ease-out motion-reduce:transition-none ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex shrink-0 items-start gap-2.5 border-b border-[var(--gray-04)] p-4">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--gray-05)] bg-[var(--gray-03)]">
            <Icon size={17} className={KIND_TINT[shown.kind]} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-[var(--gray-12)]">
              {shown.label}
            </h2>
            {summary !== "—" && (
              <p className="mt-0.5 truncate text-xs text-[var(--gray-09)]">
                {summary}
              </p>
            )}
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={requestClose}
            aria-label="Close"
            className="shrink-0 rounded p-1 text-[var(--gray-09)] transition-colors hover:text-[var(--gray-12)]"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
          <div className="flex items-center justify-between gap-2">
            <ConnectorStatusBadge
              status={shown.status}
              availability={shown.availability}
            />
            {shown.target && shown.connectMethod === "oauth" && (
              <code className="truncate font-mono text-xs text-[var(--gray-10)]">
                {shown.target}
              </code>
            )}
          </div>
          <p className="text-xs leading-relaxed text-[var(--gray-09)]">
            {shown.description}
          </p>

          <ConnectionPathSummary connector={shown} />

          {shown.connectMethod === "oauth" ? (
            <OAuthManage
              key={shown.kind}
              connector={shown}
              workspaceId={workspaceId}
              canManage={canManage}
            />
          ) : (
            <SecretManage
              key={shown.kind}
              connector={shown}
              workspaceId={workspaceId}
              canManage={canManage}
              onChanged={onChanged}
            />
          )}

          {!canManage && (
            <p className="flex items-start gap-1.5 border-t border-[var(--gray-04)] pt-3 text-xs leading-relaxed text-[var(--gray-08)]">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              Read-only. Ask a workspace admin to make changes.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

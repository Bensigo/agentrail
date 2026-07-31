"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Radio, AlertCircle, ChevronDown, ExternalLink, CheckCircle2, X } from "lucide-react";
import { ConnectorStatusBadge } from "./connector-status-badge";
import { KIND_ICON, KIND_TINT } from "./connector-icon-map";
import {
  capabilitySummary,
  validateConnectorCredential,
  type ConnectorConnectMeta,
  type ConnectorView,
} from "./connector-helpers";

// --------------------------------------------------------------------------- //
// Trigger controls (#816) — the heartbeat toggle + poll config for a connected
// ingest connector. Unchanged from the pre-sheet accordion body other than its
// new home.
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
// OAuth-primary button for a `connectMethod: "secret"` provider (W3-T1,
// OAuth Connect Wave 3, `.superpowers/sdd/plan-oauth.md`) — DISTINCT from
// `OAuthManage` below: that component is GitHub's own OAuth-native
// (`connectMethod: "oauth"`) card body; this one is a small ADDITIVE primary
// action `SecretManage` renders ABOVE its existing token form when
// `connector.oauthReady` is true (see that component's own doc-comment for
// why `connectMethod` itself never flips — the plan's own pinned
// constraint). Posts to the GENERIC `.../connectors/oauth/link` route
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
// Secret connector management — MCP-key connectors only (linear/figma/
// context7/observability providers). Posts the credential to the write-only
// /connectors/secret route; the value is never read back.
// --------------------------------------------------------------------------- //

// Module-level (not per-render) empty-array fallbacks for `secretParts` /
// `extraConfigFields` when a catalog entry declares neither — reusing the
// SAME reference on every render (rather than a fresh `?? []` literal each
// time) keeps `save`'s useCallback dependency array referentially stable for
// every provider that predates this wave (react-hooks/exhaustive-deps).
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

  // Task P0: composite secrets — a catalog entry declaring `secretParts`
  // renders ONE password input PER PART instead of the single credential
  // input; the parts are joined `partA:partB` right before the PUT (see
  // `apps/console/lib/evidence/composite-secret.ts`'s own doc-comment).
  // Absent (every provider before this wave) → `secretParts` is `[]` and
  // the original single-input rendering below is completely unaffected.
  const secretParts = meta?.secretParts ?? NO_SECRET_PARTS;
  const isComposite = secretParts.length > 0;
  const [secret, setSecret] = useState("");
  const [partValues, setPartValues] = useState<string[]>(() => secretParts.map(() => ""));

  // Task P0 (generalizes Task 7's single `extraValue` string): N generic
  // extra config fields, driven entirely by the catalog entry's
  // `connect.extraConfigFields` — this component never hardcodes which
  // provider needs one or how many, so the NEXT provider needing extra
  // fields is catalog-only. See connector-helpers.ts's own doc-comment on
  // ConnectorConnectMeta.extraConfigFields.
  const extraFields = meta?.extraConfigFields ?? NO_EXTRA_FIELDS;
  const [extraValues, setExtraValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // W3-T1 (OAuth Connect Wave 3): whether the token-paste form has been
  // explicitly revealed via "Use an API token instead". Only READ when
  // `connector.oauthReady` is true (see the not-connected branch below) —
  // declared unconditionally here regardless, per the Rules of Hooks.
  const [manualOpen, setManualOpen] = useState(false);

  const save = useCallback(
    async (body: { secret: string | null }) => {
      setSaving(true);
      setErr(null);
      try {
        // Computed BEFORE the secret PUT (Task P2 — see this component's own
        // note below at the persistence call for why the SAME entries also
        // ride ALONGSIDE the secret in the request below, not just here).
        const configEntries = extraFields
          .map((f) => [f.key, (extraValues[f.key] ?? "").trim()] as const)
          .filter(([, v]) => v.length > 0);

        const res = await fetch(
          `/api/v1/workspaces/${workspaceId}/connectors/secret`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            // Task P2: a catalog entry's extraConfigFields values ride
            // ALONGSIDE the secret in this SAME request (in addition to the
            // dedicated persistence call below) — some providers' live
            // verify needs a not-yet-persisted extra field (Langfuse's host:
            // `verify.ts` calls `GET {host}/api/public/projects`, and at
            // THIS point in the flow no config PUT has run yet — see
            // `verify.ts`'s own doc-comment). secret/route.ts reads these
            // ONLY to hand to verify; it never persists them itself (the
            // dedicated config PUT below remains the sole persistence
            // path), so this is harmless for every provider whose secret
            // route doesn't consume them (every provider before this task,
            // including Railway's own `railwayProjectId`). Never sent on a
            // disconnect (`body.secret === null`).
            body: JSON.stringify({
              provider: connector.kind,
              ...body,
              ...(body.secret !== null ? Object.fromEntries(configEntries) : {}),
            }),
          }
        );
        if (!res.ok) {
          const b = await res.json().catch(() => ({}));
          throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`);
        }

        // The extra fields (when the catalog entry declares any) ALSO save
        // via the connectors CONFIG route (the sole persistence path for
        // them — see the note above), and only once the credential itself
        // is accepted, so a rejected token never leaves an orphaned config
        // value behind. Never attempted on a disconnect (`body.secret ===
        // null`). Only non-empty values are sent, so an optional field left
        // blank never overwrites a previously-stored one with an empty
        // string.
        if (body.secret !== null && configEntries.length > 0) {
          const configRes = await fetch(
            `/api/v1/workspaces/${workspaceId}/connectors`,
            {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                provider: connector.kind,
                ...Object.fromEntries(configEntries),
              }),
            }
          );
          if (!configRes.ok) {
            const b = await configRes.json().catch(() => ({}));
            throw new Error((b as { error?: string }).error ?? `HTTP ${configRes.status}`);
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

  const missingRequiredExtra = extraFields.find(
    (f) => f.required !== false && (extraValues[f.key] ?? "").trim().length === 0
  );

  // W3-T1 (OAuth Connect Wave 3): the token-paste form itself, computed ONCE
  // as a plain JSX value so it can be rendered from EITHER branch below
  // (unaffected by `oauthReady`) rather than duplicated in source — the
  // `!connector.oauthReady` branch returns this exact same element, so a
  // provider without OAuth readiness renders byte-identically to before
  // this task (no visual regression — the plan's own pinned requirement).
  const tokenForm = (
    <form
      onSubmit={(e) => {
        e.preventDefault();

        // Task P0: a composite provider joins its N part inputs into the
        // single `partA:partB` string right here, client-side, before any
        // validation runs — see composite-secret.ts's own doc-comment on
        // why a raw part must never contain the `:` delimiter.
        let credential: string;
        if (isComposite) {
          const emptyIdx = partValues.findIndex((v) => v.trim().length === 0);
          if (emptyIdx !== -1) {
            setErr(`${secretParts[emptyIdx].name} is required.`);
            return;
          }
          const colonIdx = partValues.findIndex((v) => v.includes(":"));
          if (colonIdx !== -1) {
            setErr(`${secretParts[colonIdx].name} must not contain ":".`);
            return;
          }
          credential = partValues.map((v) => v.trim()).join(":");
        } else {
          credential = secret;
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
        save({ secret: credential.trim() });
      }}
      className="flex flex-col gap-2"
    >
      {isComposite ? (
        secretParts.map((part, i) => (
          <input
            key={part.name}
            aria-label={part.name}
            type="password"
            autoComplete="off"
            placeholder={part.name}
            value={partValues[i] ?? ""}
            disabled={!canManage}
            onChange={(e) =>
              setPartValues((prev) => {
                const next = [...prev];
                next[i] = e.target.value;
                return next;
              })
            }
            className="h-8 w-full rounded border border-[var(--gray-05)] bg-[var(--gray-01)] px-2 font-mono text-xs text-[var(--gray-12)] placeholder:text-[var(--gray-07)] outline-none focus:border-[var(--gray-08)] disabled:opacity-50"
          />
        ))
      ) : (
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
      )}
      {meta?.credentialHint && (
        <p className="text-xs text-[var(--gray-08)]">{meta.credentialHint}</p>
      )}
      {extraFields.map((field) => (
        <input
          key={field.key}
          aria-label={field.label}
          type="text"
          autoComplete="off"
          placeholder={field.placeholder}
          value={extraValues[field.key] ?? ""}
          disabled={!canManage}
          onChange={(e) =>
            setExtraValues((prev) => ({ ...prev, [field.key]: e.target.value }))
          }
          className="h-8 w-full rounded border border-[var(--gray-05)] bg-[var(--gray-01)] px-2 font-mono text-xs text-[var(--gray-12)] placeholder:text-[var(--gray-07)] outline-none focus:border-[var(--gray-08)] disabled:opacity-50"
        />
      ))}
      <button
        type="submit"
        disabled={
          !canManage ||
          saving ||
          (isComposite
            ? partValues.some((v) => v.trim().length === 0)
            : secret.trim().length === 0) ||
          Boolean(missingRequiredExtra)
        }
        className="h-8 w-full rounded border border-[var(--gray-06)] bg-[var(--gray-03)] text-xs font-medium text-[var(--gray-12)] hover:border-[var(--gray-08)] transition-colors disabled:opacity-50"
      >
        {saving ? "Connecting…" : "Connect"}
      </button>
      {err && <p className="text-xs text-[var(--red-11)]">{err}</p>}
      <SetupHelp connector={connector} />
    </form>
  );

  // Without oauthReady: exactly today's UI — the bare token form, nothing
  // wrapping it (plan's own pinned "no visual regression" requirement).
  if (!connector.oauthReady) {
    return tokenForm;
  }

  // oauthReady: an OAuth-primary "Connect {label}" button, plus a quiet
  // disclosure that reveals the SAME token form on demand — the plan's own
  // pinned sheet contract. One-way reveal (no "hide again" affordance):
  // once a workspace admin opts into token-paste for this connect attempt,
  // there is no reason to re-hide it. Like every other piece of local state
  // in this component (`secret`, `partValues`, `extraValues`), `manualOpen`
  // persists across closing and reopening the SAME connector's sheet (the
  // parent `ConnectorSheet` only remounts this component via its
  // `key={shown.kind}` when the OPEN connector actually changes — see that
  // component's own doc-comment on `shown`) — it resets by switching to a
  // different connector, or a full page reload, not by close+reopen alone.
  return (
    <div className="flex flex-col gap-2">
      {meta?.oauthHint && (
        <p className="text-xs leading-relaxed text-[var(--gray-09)]">{meta.oauthHint}</p>
      )}
      <OauthConnectButton connector={connector} workspaceId={workspaceId} canManage={canManage} />
      {manualOpen ? (
        tokenForm
      ) : (
        <button
          type="button"
          onClick={() => setManualOpen(true)}
          className="self-start text-xs text-[var(--gray-09)] hover:text-[var(--gray-11)] underline-offset-2 hover:underline"
        >
          Use an API token instead
        </button>
      )}
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
  // contract, which SecretManage/TriggerControls already honored).
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
// The connect/manage overlay (Connectors UX v2, Track A) — the ONE surface
// every provider's connect flow, live-verify errors, connected details, and
// heartbeat controls render into. Replaces the old per-tile inline accordion
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
// description, heartbeat controls) is already provider-agnostic.
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

          {shown.status === "connected" && shown.capabilities.ingest && (
            <TriggerControls
              key={`${shown.kind}-trigger`}
              connector={shown}
              workspaceId={workspaceId}
              canManage={canManage}
              onChanged={onChanged}
            />
          )}

          {!canManage && (
            <p className="flex items-start gap-1.5 border-t border-[var(--gray-04)] pt-3 text-xs leading-relaxed text-[var(--gray-08)]">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              You have read-only access to connectors. Ask a workspace admin
              to make changes here.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

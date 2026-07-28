"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type {
  BriefArea,
  BriefItem,
  BriefItemKind,
  BriefItemResolution,
  BriefItemState,
} from "@agentrail/db-postgres";
import { AlertTriangle, Pencil, Trash2, X } from "lucide-react";
import {
  AREA_LABELS,
  AREA_ORDER,
  KIND_LABELS,
  RESOLUTION_LABELS,
  STATE_LABELS,
} from "../briefs-format";
import { AuthorityBadge, KindBadge, ResolutionBadge, StateBadge } from "./badges";

const KIND_VALUES: BriefItemKind[] = ["required", "optional", "unknown", "out-of-scope"];
const STATE_VALUES: BriefItemState[] = ["open", "resolved"];
const RESOLUTION_VALUES: BriefItemResolution[] = [
  "implemented",
  "deferred",
  "rejected",
  "satisfied-elsewhere",
];

const INPUT_CLASSNAME =
  "rounded bg-[var(--gray-01)] border border-[var(--gray-05)] px-2 py-1 text-xs text-[var(--gray-12)] placeholder:text-[var(--gray-08)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-text)] focus:ring-offset-1 focus:ring-offset-[var(--gray-02)]";

interface BriefItemCardProps {
  item: BriefItem;
  workspaceId: string;
  slug: string;
  /** Owner/admin only — mirrors every other console mutation gate
   * (`goals/page.tsx`'s own `canManage`). The matching server-side check
   * lives on the item route; a client-hidden Edit/Delete button is a
   * courtesy, not the actual boundary. */
  canManage: boolean;
  /** From `isBlockingItem` — this item is `open` + `unknown`, one of the
   * things currently keeping `computeBriefReadiness` false. Purely a
   * highlight; the authoritative check is the page's own readiness banner. */
  blocking: boolean;
}

/**
 * One brief item — read view plus, for an owner/admin, an inline edit form
 * that PATCHes `authority: human` onto this row (never `patchBriefItems`;
 * that route is Jace's write path and would silently skip a second edit to
 * an already-human item — see `updateBriefItemAsHuman`'s doc-comment). This
 * is the concrete UI for the design spec's "Human edits win" section: the
 * moment a human saves here, `authority` flips to `human` and stays locked
 * against Jace's own patches from then on.
 */
export function BriefItemCard({ item, workspaceId, slug, canManage, blocking }: BriefItemCardProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [area, setArea] = useState<BriefArea>(item.area);
  const [statement, setStatement] = useState(item.statement);
  const [evidence, setEvidence] = useState(item.evidence);
  const [kind, setKind] = useState<BriefItemKind>(item.kind);
  const [state, setState] = useState<BriefItemState>(item.state);
  const [resolution, setResolution] = useState<BriefItemResolution | "">(item.resolution ?? "");

  // Client-side mirror of the store's unknown-may-never-resolve invariant
  // (`updateBriefItemAsHuman`'s own doc-comment) — a courtesy that disables
  // the illegal combination in the picker itself rather than only surfacing
  // it as a 400 after submit. The route re-checks this regardless; this is
  // UX, not the enforcement.
  const unknownBlocksResolve = kind === "unknown";

  function startEdit() {
    setArea(item.area);
    setStatement(item.statement);
    setEvidence(item.evidence);
    setKind(item.kind);
    setState(item.state);
    setResolution(item.resolution ?? "");
    setError(null);
    setEditing(true);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/workspaces/${workspaceId}/briefs/${slug}/items/${item.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            area,
            statement: statement.trim(),
            evidence,
            kind,
            state,
            resolution: state === "resolved" ? resolution || null : null,
          }),
        }
      );
      const raw = await res.text();
      const body = raw ? (JSON.parse(raw) as { error?: string; errors?: Record<string, string> }) : {};
      if (!res.ok) {
        throw new Error(body.error ?? Object.values(body.errors ?? {})[0] ?? `HTTP ${res.status}`);
      }
      setEditing(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save this item");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!window.confirm("Delete this item? This cannot be undone.")) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/workspaces/${workspaceId}/briefs/${slug}/items/${item.id}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete this item");
      setDeleting(false);
    }
  }

  if (editing) {
    return (
      <div className="rounded border border-[var(--accent-text)] bg-[var(--gray-02)] p-3">
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-[var(--gray-09)]">Area</span>
              <select
                value={area}
                onChange={(e) => setArea(e.target.value as BriefArea)}
                className={INPUT_CLASSNAME}
              >
                {AREA_ORDER.map((a) => (
                  <option key={a} value={a}>
                    {AREA_LABELS[a]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-[var(--gray-09)]">Kind</span>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as BriefItemKind)}
                className={INPUT_CLASSNAME}
              >
                {KIND_VALUES.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-[var(--gray-09)]">Statement</span>
            <textarea
              value={statement}
              onChange={(e) => setStatement(e.target.value)}
              rows={2}
              className={`${INPUT_CLASSNAME} resize-none`}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-[var(--gray-09)]">
              Evidence — the human&apos;s own words that settled this
            </span>
            <textarea
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
              rows={2}
              placeholder="Quote what was actually said, verbatim"
              className={`${INPUT_CLASSNAME} resize-none`}
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-[var(--gray-09)]">State</span>
              <select
                value={state}
                onChange={(e) => setState(e.target.value as BriefItemState)}
                disabled={unknownBlocksResolve}
                className={`${INPUT_CLASSNAME} disabled:opacity-50`}
                title={
                  unknownBlocksResolve
                    ? "An 'unknown' item can't resolve — answer it (change kind) or mark it out-of-scope first"
                    : undefined
                }
              >
                {STATE_VALUES.map((s) => (
                  <option key={s} value={s}>
                    {STATE_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
            {state === "resolved" && !unknownBlocksResolve && (
              <label className="flex flex-col gap-1">
                <span className="text-xs text-[var(--gray-09)]">Resolution</span>
                <select
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value as BriefItemResolution)}
                  className={INPUT_CLASSNAME}
                >
                  <option value="">Select…</option>
                  {RESOLUTION_VALUES.map((r) => (
                    <option key={r} value={r}>
                      {RESOLUTION_LABELS[r]}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {unknownBlocksResolve && (
            <p className="flex items-center gap-1 text-xs text-[var(--red-11)]">
              <AlertTriangle size={12} />
              An unknown item is not a requirement yet — there is nothing to resolve. Answer it
              (change kind to required/optional) or mark it out-of-scope.
            </p>
          )}

          {error && <p className="text-xs text-[var(--red-11)]">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="h-7 px-2.5 rounded bg-[var(--gray-03)] border border-[var(--gray-06)] text-xs text-[var(--gray-12)] hover:border-[var(--gray-08)] transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving || !statement.trim()}
              className="h-7 px-3 rounded bg-[var(--yellow-09)] text-black text-xs font-medium hover:bg-[var(--yellow-09-hover)] disabled:opacity-50 transition-colors"
            >
              {saving ? "Saving…" : "Save correction"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`rounded border p-3 ${
        blocking ? "border-[var(--red-09)]" : "border-[var(--gray-05)]"
      } bg-[var(--gray-02)]`}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-[var(--gray-12)]">{item.statement}</p>
        {canManage && (
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={startEdit}
              aria-label="Edit item"
              className="rounded p-1 text-[var(--gray-09)] hover:text-[var(--gray-12)] transition-colors"
            >
              <Pencil size={13} />
            </button>
            <button
              type="button"
              onClick={remove}
              disabled={deleting}
              aria-label="Delete item"
              className="rounded p-1 text-[var(--gray-09)] hover:text-[var(--red-11)] transition-colors disabled:opacity-50"
            >
              {deleting ? <X size={13} /> : <Trash2 size={13} />}
            </button>
          </div>
        )}
      </div>

      {item.evidence && (
        <p className="mt-1 text-xs italic text-[var(--gray-09)]">&ldquo;{item.evidence}&rdquo;</p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <KindBadge kind={item.kind} />
        <StateBadge state={item.state} />
        {item.resolution && <ResolutionBadge resolution={item.resolution} />}
        <AuthorityBadge authority={item.authority} />
        {blocking && (
          <span className="flex items-center gap-1 text-xs font-medium text-[var(--red-11)]">
            <AlertTriangle size={12} />
            Blocks to-issues
          </span>
        )}
      </div>

      {error && <p className="mt-2 text-xs text-[var(--red-11)]">{error}</p>}
    </div>
  );
}

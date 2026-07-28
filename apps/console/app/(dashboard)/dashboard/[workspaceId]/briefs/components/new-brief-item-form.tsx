"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { BriefArea, BriefItemKind } from "@agentrail/db-postgres";
import { Plus } from "lucide-react";
import { KIND_LABELS } from "../briefs-format";

const KIND_VALUES: BriefItemKind[] = ["required", "optional", "unknown", "out-of-scope"];

const INPUT_CLASSNAME =
  "rounded bg-[var(--gray-01)] border border-[var(--gray-05)] px-2 py-1 text-xs text-[var(--gray-12)] placeholder:text-[var(--gray-08)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-text)] focus:ring-offset-1 focus:ring-offset-[var(--gray-02)]";

/**
 * "Add item" for one area group — the console-side create path for a
 * human-authored item Jace never wrote (design spec's "add a way to CREATE
 * a human-authored item" ask). Scoped to a single `area` per instance (the
 * area group header renders one of these, so the area is implicit, not a
 * field the human has to pick) — the new item always lands `state: 'open'`
 * (a human adding a fresh requirement isn't simultaneously resolving it) and
 * `authority: 'human'` server-side, unconditionally.
 */
export function NewBriefItemForm({
  workspaceId,
  slug,
  area,
}: {
  workspaceId: string;
  slug: string;
  area: BriefArea;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [statement, setStatement] = useState("");
  const [evidence, setEvidence] = useState("");
  const [kind, setKind] = useState<BriefItemKind>("required");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setStatement("");
    setEvidence("");
    setKind("required");
    setError(null);
  }

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/briefs/${slug}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ area, statement: statement.trim(), evidence, kind }),
      });
      const raw = await res.text();
      const body = raw ? (JSON.parse(raw) as { error?: string; errors?: Record<string, string> }) : {};
      if (!res.ok) {
        throw new Error(body.error ?? Object.values(body.errors ?? {})[0] ?? `HTTP ${res.status}`);
      }
      reset();
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add this item");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 text-xs text-[var(--gray-09)] hover:text-[var(--gray-12)] transition-colors"
      >
        <Plus size={12} />
        Add item
      </button>
    );
  }

  return (
    <div className="rounded border border-dashed border-[var(--gray-06)] bg-[var(--gray-01)] p-3">
      <div className="flex flex-col gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--gray-09)]">Statement</span>
          <textarea
            value={statement}
            onChange={(e) => setStatement(e.target.value)}
            rows={2}
            placeholder="What did you decide?"
            autoFocus
            className={`${INPUT_CLASSNAME} resize-none`}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--gray-09)]">Evidence (optional) — your own words</span>
          <textarea
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
            rows={2}
            placeholder="Quote yourself, verbatim, if useful"
            className={`${INPUT_CLASSNAME} resize-none`}
          />
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

        {error && <p className="text-xs text-[var(--red-11)]">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={() => {
              reset();
              setOpen(false);
            }}
            className="h-7 px-2.5 rounded bg-[var(--gray-03)] border border-[var(--gray-06)] text-xs text-[var(--gray-12)] hover:border-[var(--gray-08)] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving || !statement.trim()}
            className="h-7 px-3 rounded bg-[var(--yellow-09)] text-black text-xs font-medium hover:bg-[var(--yellow-09-hover)] disabled:opacity-50 transition-colors"
          >
            {saving ? "Adding…" : "Add item"}
          </button>
        </div>
      </div>
    </div>
  );
}

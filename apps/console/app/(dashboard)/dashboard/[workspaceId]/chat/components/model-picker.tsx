"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { ChatModelOption } from "../../../../../../lib/chat/models";

/**
 * The chat header's model dropdown (#1288). Options come from the single
 * source of truth (`lib/chat/models.ts`); each carries an `enabled` flag the
 * SERVER computed from the routing config, so a model with no running Jace
 * endpoint renders DISABLED with a "not enabled" hint rather than as a dead,
 * selectable option that would route nowhere. Selecting only ever picks an
 * enabled model; the choice rides on the next message's POST body.
 *
 * Interaction mirrors `WorkspaceSwitcher` (the console's existing dropdown
 * idiom): a button + absolutely-positioned listbox, closing on outside click
 * or Escape, using the app's own token set — no new UI primitive.
 */
export function ModelPicker({
  models,
  value,
  onChange,
}: {
  models: readonly ChatModelOption[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const active = models.find((m) => m.id === value) ?? models[0];

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!active) return null;

  function select(id: string, enabled: boolean) {
    if (!enabled) return;
    setOpen(false);
    if (id !== value) onChange(id);
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-md border border-[var(--gray-05)] bg-[var(--gray-02)] px-2.5 py-1.5 text-xs text-[var(--gray-12)] transition-colors hover:bg-[var(--gray-03)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-text)]"
      >
        <span className="max-w-[10rem] truncate font-medium">{active.label}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--gray-09)]" />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute right-0 top-full z-50 mt-1 w-60 overflow-hidden rounded-md border border-[var(--gray-05)] bg-[var(--gray-02)] py-1"
          style={{ boxShadow: "var(--shadow-dropdown)" }}
        >
          <div className="px-2.5 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--gray-08)]">
            Model
          </div>
          <div className="max-h-72 overflow-y-auto">
            {models.map((m) => {
              const isActive = m.id === value;
              return (
                <button
                  key={m.id}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  aria-disabled={!m.enabled}
                  disabled={!m.enabled}
                  onClick={() => select(m.id, m.enabled)}
                  className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors focus:outline-none ${
                    m.enabled
                      ? "hover:bg-[var(--gray-03)] focus-visible:bg-[var(--gray-03)]"
                      : "cursor-not-allowed opacity-60"
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-[var(--gray-12)]">{m.label}</span>
                    {!m.enabled && (
                      <span className="block text-[10px] text-[var(--gray-08)]">not enabled</span>
                    )}
                  </span>
                  {isActive && m.enabled && (
                    <Check className="h-3.5 w-3.5 shrink-0 text-[var(--gray-12)]" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

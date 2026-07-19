"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronsUpDown, Plus } from "lucide-react";

type Workspace = { id: string; name: string; slug: string; role: string };

interface WorkspaceSwitcherProps {
  workspaces: Workspace[];
  activeId: string;
}

// Deterministic avatar background derived from the workspace id, so each
// workspace keeps a stable colour across renders and sessions.
const AVATAR_COLORS = [
  "var(--yellow-09)", // brand yellow
  "#46a758", // green
  "#3e9bff", // blue
  "#e93d82", // pink
  "var(--orange-09)", // orange
  "#8e4ec6", // purple
  "var(--teal-09)", // teal
  "var(--red-09)", // red
];

function avatarColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function WorkspaceAvatar({ workspace, size = 20 }: { workspace: Workspace; size?: number }) {
  const bg = avatarColor(workspace.id);
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-[5px] font-bold text-black"
      style={{
        width: size,
        height: size,
        background: bg,
        fontSize: size * 0.5,
        lineHeight: 1,
      }}
    >
      {(workspace.name[0] ?? "?").toUpperCase()}
    </span>
  );
}

export function WorkspaceSwitcher({ workspaces, activeId }: WorkspaceSwitcherProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const active =
    workspaces.find((w) => w.id === activeId) ?? workspaces[0] ?? null;

  // Close on outside click or Escape.
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

  function selectWorkspace(id: string) {
    setOpen(false);
    if (id !== activeId) router.push(`/dashboard/${id}/`);
  }

  function createWorkspace() {
    setOpen(false);
    router.push("/setup");
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors duration-150 hover:bg-[var(--gray-03)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-accent)]"
      >
        <WorkspaceAvatar workspace={active} size={22} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-[var(--gray-12)]">
            {active.name}
          </span>
          <span className="block truncate text-[11px] capitalize text-[var(--gray-09)]">
            {active.role}
          </span>
        </span>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-[var(--gray-09)]" />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-md border border-[var(--gray-05)] bg-[var(--gray-02)] py-1 shadow-2xl"
          style={{ boxShadow: "var(--shadow-dropdown)" }}
        >
          <div className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--gray-08)]">
            Workspaces
          </div>
          <div className="max-h-64 overflow-y-auto">
            {workspaces.map((w) => {
              const isActive = w.id === active.id;
              return (
                <button
                  key={w.id}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onClick={() => selectWorkspace(w.id)}
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors duration-150 hover:bg-[var(--gray-03)] focus:outline-none focus-visible:bg-[var(--gray-03)]"
                >
                  <WorkspaceAvatar workspace={w} size={20} />
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--gray-12)]">
                    {w.name}
                  </span>
                  {isActive && (
                    <Check className="h-3.5 w-3.5 shrink-0 text-[var(--brand-accent)]" />
                  )}
                </button>
              );
            })}
          </div>
          <div className="my-1 h-px bg-[var(--gray-05)]" />
          <button
            type="button"
            onClick={createWorkspace}
            className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors duration-150 hover:bg-[var(--gray-03)] focus:outline-none focus-visible:bg-[var(--gray-03)]"
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] border border-dashed border-[var(--gray-07)] text-[var(--gray-10)]">
              <Plus className="h-3 w-3" />
            </span>
            <span className="text-sm text-[var(--gray-11)]">Create workspace</span>
          </button>
        </div>
      )}
    </div>
  );
}

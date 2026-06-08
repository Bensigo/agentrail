"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter, useParams } from "next/navigation";

interface WorkspaceItem {
  id: string;
  name: string;
  slug: string;
  role: string;
}

export function WorkspaceSwitcher({
  workspaces,
}: {
  workspaces: WorkspaceItem[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const params = useParams();
  const activeId = params.workspaceId as string | undefined;

  const active = workspaces.find((w) => w.id === activeId) ?? workspaces[0];

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  if (!active) return null;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-[var(--gray-12)] transition-colors duration-150 hover:bg-[var(--gray-03)]"
      >
        <span className="h-5 w-5 rounded-sm bg-[var(--brand-accent)] text-center text-xs font-bold leading-5 text-black">
          {active.name[0]}
        </span>
        <span className="flex-1 truncate">{active.name}</span>
        <svg
          className={`h-3 w-3 text-[var(--gray-09)] transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-56 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] py-1 shadow-lg">
          {workspaces.map((ws) => (
            <button
              key={ws.id}
              onClick={() => {
                router.push(`/dashboard/${ws.id}`);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors duration-150 hover:bg-[var(--gray-03)] ${
                ws.id === active.id
                  ? "text-[var(--brand-accent)]"
                  : "text-[var(--gray-12)]"
              }`}
            >
              <span className="h-5 w-5 rounded-sm bg-[var(--gray-04)] text-center text-xs font-bold leading-5">
                {ws.name[0]}
              </span>
              <span className="flex-1 truncate">{ws.name}</span>
              <span className="text-xs text-[var(--gray-09)]">{ws.role}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

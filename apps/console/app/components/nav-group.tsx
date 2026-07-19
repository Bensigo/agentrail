"use client";

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  ENGINE_ROOM_STORAGE_KEY,
  isEngineRoomRoute,
  resolveEngineRoomOpen,
  type NavZone,
} from "./sidebar-nav";
import { NavLink } from "./nav-link";

/**
 * Collapsible "Engine room" zone. Defaults collapsed; open/closed persists to
 * localStorage; landing directly on an engine-room route (including nested
 * routes like /runs/[runId]) forces it open and highlights the active item.
 *
 * localStorage is read client-side only (useEffect), so the initial render —
 * server and client — resolves purely from the route via
 * `resolveEngineRoomOpen(pathname, basePath, null)`, keeping SSR output and
 * first hydration in sync with no flash of wrong state on deep links.
 */
export function EngineRoomGroup({
  zone,
  pathname,
  basePath,
}: {
  zone: NavZone;
  pathname: string;
  basePath: string;
}) {
  const [open, setOpen] = useState(() =>
    resolveEngineRoomOpen(pathname, basePath, null)
  );

  useEffect(() => {
    if (isEngineRoomRoute(pathname, basePath)) {
      setOpen(true);
      return;
    }
    const stored =
      typeof window === "undefined"
        ? null
        : window.localStorage.getItem(ENGINE_ROOM_STORAGE_KEY);
    setOpen(resolveEngineRoomOpen(pathname, basePath, stored));
  }, [pathname, basePath]);

  function toggle() {
    setOpen((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") {
        window.localStorage.setItem(ENGINE_ROOM_STORAGE_KEY, String(next));
      }
      return next;
    });
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        title={zone.label}
        className="flex w-full items-center justify-between rounded px-2 py-1 text-xs font-normal uppercase tracking-wide text-[var(--gray-09)] transition-colors duration-150 hover:text-[var(--gray-12)] max-md:justify-center"
      >
        <span className="max-md:hidden">{zone.label}</span>
        <ChevronDown
          className={`h-3 w-3 shrink-0 transition-transform duration-150 ease-out max-md:hidden ${
            open ? "rotate-0" : "-rotate-90"
          }`}
          aria-hidden="true"
        />
      </button>
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          {zone.items.map((item) => (
            <NavLink key={item.href} item={item} basePath={basePath} pathname={pathname} />
          ))}
        </div>
      </div>
    </div>
  );
}

"use client";

import { usePathname } from "next/navigation";
import { breadcrumbLabel } from "./breadcrumb-label";

/**
 * Derives a page-title breadcrumb from the current route (mapping lives in
 * ./breadcrumb-label so it's unit-testable). Placed in the h-12 top bar left
 * slot; falls back to "Home" at the workspace root.
 */
export function TopBarBreadcrumb() {
  const pathname = usePathname();

  return (
    <p className="text-sm font-medium text-[var(--gray-12)]">
      {breadcrumbLabel(pathname)}
    </p>
  );
}

"use client";

import Link from "next/link";
import { isNavItemActive, type NavItem } from "./sidebar-nav";

/** One sidebar row. Shared by the flat zones and the Engine room group so active-state styling stays identical everywhere. */
export function NavLink({
  item,
  basePath,
  pathname,
}: {
  item: NavItem;
  basePath: string;
  pathname: string;
}) {
  const { label, href, icon: Icon } = item;
  const fullHref = href ? `${basePath}/${href}` : basePath;
  const isActive = isNavItemActive(pathname, basePath, href);

  return (
    <Link
      href={fullHref}
      className={`relative flex items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors duration-150 max-md:justify-center max-md:px-0 ${
        isActive
          ? "bg-[var(--gray-03)] text-[var(--brand-accent)]"
          : "text-[var(--gray-11)] hover:bg-[var(--gray-02)] hover:text-[var(--gray-12)]"
      }`}
      title={label}
    >
      {isActive && (
        <span
          className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r-sm bg-[var(--brand-accent)]"
          aria-hidden="true"
        />
      )}
      <Icon className="h-4 w-4 shrink-0" />
      <span className="max-md:hidden">{label}</span>
    </Link>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";

type Workspace = { id: string; name: string; slug: string; role: string };

export function WorkspaceSwitcher() {
  const router = useRouter();
  const pathname = usePathname();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);

  // Extract workspaceId from /dashboard/[workspaceId]/...
  const pathParts = pathname.split("/");
  const dashboardIdx = pathParts.indexOf("dashboard");
  const activeId =
    dashboardIdx !== -1 && pathParts.length > dashboardIdx + 1
      ? pathParts[dashboardIdx + 1]
      : undefined;

  useEffect(() => {
    fetch("/api/v1/workspaces")
      .then((r) => r.json())
      .then((data: Workspace[]) => {
        setWorkspaces(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div
        style={{
          padding: "0.5rem 0.75rem",
          color: "var(--gray-08)",
          fontSize: "0.8125rem",
        }}
      >
        Loading...
      </div>
    );
  }

  if (workspaces.length === 0) return null;

  // AC6: single workspace — static label, no selection affordance
  if (workspaces.length === 1) {
    return (
      <div
        style={{
          padding: "0.5rem 0.75rem",
          fontSize: "0.8125rem",
          fontWeight: 500,
          color: "var(--gray-12)",
          background: "var(--gray-02)",
          borderRadius: "6px",
          borderLeft: "2px solid #ffe629",
          userSelect: "none",
        }}
      >
        {workspaces[0].name}
      </div>
    );
  }

  // Multiple workspaces — dropdown
  return (
    <select
      value={activeId ?? ""}
      onChange={(e) => router.push(`/dashboard/${e.target.value}/`)}
      style={{
        width: "100%",
        padding: "0.5rem 0.75rem",
        fontSize: "0.8125rem",
        fontWeight: 500,
        background: "var(--gray-02)",
        color: "var(--gray-12)",
        border: "1px solid var(--gray-04)",
        borderRadius: "6px",
        cursor: "pointer",
        outline: "none",
        appearance: "none",
        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M6 8L1 3h10z'/%3E%3C/svg%3E")`,
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right 0.6rem center",
        paddingRight: "2rem",
      }}
    >
      {workspaces.map((w) => (
        <option
          key={w.id}
          value={w.id}
          style={{
            background: w.id === activeId ? "#ffe629" : undefined,
            fontWeight: w.id === activeId ? 600 : undefined,
          }}
        >
          {w.name}
        </option>
      ))}
    </select>
  );
}

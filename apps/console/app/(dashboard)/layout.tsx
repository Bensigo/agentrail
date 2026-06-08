import { WorkspaceSwitcher } from "./components/WorkspaceSwitcher";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        minHeight: "100vh",
        fontFamily: "Inter, system-ui, sans-serif",
        background: "var(--gray-01, #111)",
        color: "var(--gray-12, #ededed)",
      }}
    >
      {/* Sidebar */}
      <aside
        style={{
          width: "220px",
          flexShrink: 0,
          background: "var(--gray-01, #111)",
          borderRight: "1px solid var(--gray-03, #222)",
          display: "flex",
          flexDirection: "column",
          padding: "1rem 0.75rem",
          gap: "0.75rem",
        }}
      >
        <div
          style={{
            fontSize: "0.75rem",
            fontWeight: 600,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--gray-08, #888)",
            padding: "0 0.25rem",
            marginBottom: "0.25rem",
          }}
        >
          Workspace
        </div>
        <WorkspaceSwitcher />
      </aside>

      {/* Main content */}
      <main style={{ flex: 1, overflow: "auto" }}>{children}</main>
    </div>
  );
}

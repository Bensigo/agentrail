import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentRail Console",
  description: "Agent operations console for workspace management, runs, context packs, and review gates.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body>
        {children}
      </body>
    </html>
  );
}

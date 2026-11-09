import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentRail — workflow for coding agents",
  description:
    "AgentRail connects any MCP-compatible coding agent to project context, development workflows and an inspectable Console.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        {/* Prevent dark/light flash: apply saved preference before first paint.
            Light is the default — only an explicit stored "dark" opts back in;
            anything else (including a first-ever visit's null) stays light. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('agentrail-theme');if(t==='dark'){document.documentElement.classList.add('dark');}else{document.documentElement.classList.remove('dark');}}catch(e){}})();`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}

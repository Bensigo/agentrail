import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jace — your AI engineer",
  description:
    "Jace is an AI engineer you talk to in chat. He turns ideas into issues, aligns with you before building, and ships pull requests — nothing merges without your review.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <head>
        {/* Prevent dark/light flash: apply saved preference before first paint */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('agentrail-theme');if(t==='light'){document.documentElement.classList.remove('dark');}else{document.documentElement.classList.add('dark');}}catch(e){}})();`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}

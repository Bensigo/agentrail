import { RootProvider } from "fumadocs-ui/provider";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";
import type { ReactNode } from "react";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <RootProvider theme={{ enabled: false }}>
      <DocsLayout {...baseOptions()} tree={source.getPageTree()}>
        {children}
      </DocsLayout>
    </RootProvider>
  );
}

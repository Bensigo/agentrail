import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: "AgentRail Docs",
      url: "/docs",
    },
    links: [
      { text: "Home", url: "/", active: "none" },
      {
        text: "GitHub",
        url: "https://github.com/Bensigo/agentrail",
        active: "none",
      },
    ],
  };
}

import type { NextConfig } from "next";
import { createMDX } from "fumadocs-mdx/next";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// ESM-safe __dirname (next.config.ts runs under "type": "module").
const __dirname = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // Standalone output produces a minimal, self-contained server bundle
  // (.next/standalone/apps/console/server.js) for the production Docker image
  // (see apps/console/Dockerfile) — copies only the traced production deps
  // instead of the whole node_modules tree.
  output: "standalone",
  // apps/console lives 2 levels below the pnpm workspace root
  // (repo-root/apps/console). File tracing must start at the workspace root so
  // the standalone bundle's dependency trace reaches the workspace `@agentrail/*`
  // packages (symlinked via pnpm) and the root node_modules/pnpm store instead of
  // stopping at apps/console — otherwise the standalone server is missing
  // modules at runtime. See https://nextjs.org/docs/app/api-reference/config/next-config-js/output#automatically-copying-traced-files
  outputFileTracingRoot: join(__dirname, "../../"),
  transpilePackages: ["@agentrail/ui", "@agentrail/contracts", "@agentrail/auth", "@agentrail/db-postgres", "@agentrail/github-app"],
  experimental: {
    // nodeMiddleware is supported at runtime in Next 15.5 (next-server.js) but
    // is not yet declared on ExperimentalConfig's types.
    // @ts-expect-error -- remove once Next types include nodeMiddleware
    nodeMiddleware: true,
    // Next 15 defaults the client router cache to 0s for dynamic segments, so
    // every sidebar navigation refetches the RSC payload. Keep dynamic pages
    // fresh for 30s so back/forward and repeat navigations are instant.
    staleTimes: {
      dynamic: 30,
    },
  },
};

const withMDX = createMDX();

export default withMDX(nextConfig);

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@agentrail/ui", "@agentrail/contracts", "@agentrail/auth", "@agentrail/db-postgres"],
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

export default nextConfig;

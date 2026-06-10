import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@agentrail/ui", "@agentrail/contracts", "@agentrail/auth", "@agentrail/db-postgres"],
  experimental: {
    // nodeMiddleware is supported at runtime in Next 15.5 (next-server.js) but
    // is not yet declared on ExperimentalConfig's types.
    // @ts-expect-error -- remove once Next types include nodeMiddleware
    nodeMiddleware: true,
  },
};

export default nextConfig;

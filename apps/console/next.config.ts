import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@agentrail/ui", "@agentrail/contracts", "@agentrail/auth", "@agentrail/db-postgres"],
  experimental: {
    nodeMiddleware: true,
  },
};

export default nextConfig;

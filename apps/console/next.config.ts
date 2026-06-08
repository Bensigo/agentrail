import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@agentrail/auth", "@agentrail/db-clickhouse", "@agentrail/db-postgres", "@agentrail/ui", "@agentrail/contracts"],
};

export default nextConfig;

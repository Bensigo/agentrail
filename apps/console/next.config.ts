import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@agentrail/auth", "@agentrail/db-postgres"],
};

export default nextConfig;

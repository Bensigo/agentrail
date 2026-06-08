import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@agentrail/ui", "@agentrail/contracts", "@agentrail/auth"],
};

export default nextConfig;

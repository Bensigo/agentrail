import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@agentrail/auth", "@agentrail/ui", "@agentrail/contracts"],
};

export default nextConfig;

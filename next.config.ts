import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@chat-adapter/slack",
    "@chat-adapter/state-pg",
    "chat",
  ],
};

export default nextConfig;

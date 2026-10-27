import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@top-pad/contract"],
  images: { unoptimized: true },
};

initOpenNextCloudflareForDev();
export default config;

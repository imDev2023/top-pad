import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@top-pad/contract", "@top-pad/vamp-shield"],
  images: { unoptimized: true },
  // Next's dev badge would sit over the pages the end-to-end tests photograph.
  devIndicators: false,
};

initOpenNextCloudflareForDev();
export default config;

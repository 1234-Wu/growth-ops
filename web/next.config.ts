import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

export default function config(phase: string): NextConfig {
 const development = phase === PHASE_DEVELOPMENT_SERVER;
 return {
  ...(development ? { distDir: ".next-dev" } : { output: "export" as const }),
  trailingSlash: true,
  images: { unoptimized: true },
  turbopack: { root: process.cwd() },
  ...(development ? {
   experimental: { proxyClientMaxBodySize: "16mb" },
   async rewrites() {
    return { beforeFiles: [
     { source: "/api/:path*", destination: "http://127.0.0.1:8787/api/:path*" },
     { source: "/health", destination: "http://127.0.0.1:8787/health" },
    ] };
   },
  } : {}),
 };
}

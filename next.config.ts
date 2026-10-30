import type { NextConfig } from "next";

const sourceCommit = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(process.env.GITHUB_SHA ?? "") ? process.env.GITHUB_SHA!.toLowerCase() : "";
const buildNumber = /^\d{1,12}$/.test(process.env.GITHUB_RUN_NUMBER ?? "") ? process.env.GITHUB_RUN_NUMBER! : "";
const nextConfig: NextConfig = {
  env: { ALKARNA_BUILD_COMMIT: sourceCommit, ALKARNA_BUILD_NUMBER: buildNumber },
  agentRules: false,
  output: "standalone",
  distDir: process.env.NEXT_DIST_DIR || ".next",
  serverExternalPackages: ["sql.js", "better-sqlite3"],
  outputFileTracingIncludes: {
    "/api/settings/legacy/**/*": ["./node_modules/sql.js/dist/sql-wasm.wasm"],
  },
};

export default nextConfig;

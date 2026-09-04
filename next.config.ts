import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  distDir: process.env.NEXT_DIST_DIR || ".next",
  serverExternalPackages: ["sql.js", "better-sqlite3"],
  outputFileTracingIncludes: {
    "/api/settings/legacy/**/*": ["./node_modules/sql.js/dist/sql-wasm.wasm"],
  },
};

export default nextConfig;

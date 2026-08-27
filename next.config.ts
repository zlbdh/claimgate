import type { NextConfig } from "next";
import {
  createGlobalSecurityHeaders,
  createSensitiveResponseHeaders,
} from "./src/server/http/security-headers";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
  async headers() {
    return [
      { source: "/(.*)", headers: createGlobalSecurityHeaders() },
      {
        source: "/api/claims/:claimId/pickup-pass/issue",
        headers: createSensitiveResponseHeaders(),
      },
      {
        source: "/api/claims/:claimId/pickup-pass/reissue",
        headers: createSensitiveResponseHeaders(),
      },
      {
        source: "/api/staff/claims/:claimId/handoff",
        headers: createSensitiveResponseHeaders(),
      },
    ];
  },
};

export default nextConfig;

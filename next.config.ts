import type { NextConfig } from "next";

const securityHeaders = [
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Permissions-Policy",
    value: "camera=(), geolocation=(), microphone=()",
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
  async headers() {
    const sensitivePickupHeaders = [
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "Cache-Control", value: "private, no-store" },
    ];
    return [
      { source: "/(.*)", headers: securityHeaders },
      { source: "/api/claims/:claimId/pickup-pass/issue", headers: sensitivePickupHeaders },
      { source: "/api/claims/:claimId/pickup-pass/reissue", headers: sensitivePickupHeaders },
      { source: "/api/staff/claims/:claimId/handoff", headers: sensitivePickupHeaders },
    ];
  },
};

export default nextConfig;

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Task 9 authenticated page scope wiring", () => {
  it("passes the existing draft update CSRF token into WebMCP closure state", () => {
    const source = readFileSync("src/app/claimant/reports/[reportId]/page.tsx", "utf8");
    expect(source).toContain("updateCsrfToken={updateCsrf}");
  });

  it("binds Claimant claim scope to public claim identity and version", () => {
    const source = readFileSync("src/app/claimant/claims/[claimId]/page.tsx", "utf8");
    expect(source).toMatch(/WebMcpPageScope[\s\S]*claimId[\s\S]*claimVersion:\s*claim\.version/);
  });

  it("mounts Staff queue and claim scopes", () => {
    const queue = readFileSync("src/app/staff/page.tsx", "utf8");
    const claim = readFileSync("src/app/staff/claims/[claimId]/page.tsx", "utf8");
    expect(queue).toContain("WebMcpPageScope");
    expect(queue).toContain('page: "STAFF_QUEUE"');
    expect(claim).toContain("WebMcpPageScope");
    expect(claim).toMatch(/claimId[\s\S]*claimVersion:\s*review\.claim\.version/);
  });
});

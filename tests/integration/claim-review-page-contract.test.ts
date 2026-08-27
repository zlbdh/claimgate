import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Task 7 private page and physical route contracts", () => {
  it("has four separate physical POST routes and no body-dispatched decision route", () => {
    const paths = [
      "src/app/api/claims/[claimId]/evidence/route.ts",
      "src/app/api/staff/claims/[claimId]/approve/route.ts",
      "src/app/api/staff/claims/[claimId]/reject/route.ts",
      "src/app/api/staff/claims/[claimId]/unlock/route.ts",
    ];
    for (const path of paths) {
      expect(existsSync(path), path).toBe(true);
      const source = readFileSync(path, "utf8");
      expect(source).toContain("export async function POST");
      expect(source).not.toMatch(/decisionType|switch\s*\(.*action/i);
    }
  });

  it("renders dynamic Claimant and Staff pages through closed role-specific helpers", () => {
    expect(existsSync("src/app/staff/page.tsx")).toBe(true);
    expect(existsSync("src/app/staff/claims/[claimId]/page.tsx")).toBe(true);
    const claimant = readFileSync("src/app/claimant/claims/[claimId]/page.tsx", "utf8");
    const staffQueue = readFileSync("src/app/staff/page.tsx", "utf8");
    const staffReview = readFileSync("src/app/staff/claims/[claimId]/page.tsx", "utf8");
    expect(claimant).toContain("EvidenceForm");
    expect(claimant).toContain("ClaimStepper");
    expect(staffQueue).toContain("readStaffPageSession");
    expect(staffQueue).toContain("waitingDurationMs");
    expect(staffReview).toContain("StaffDecisionForm");
    expect(staffReview).toContain("<time");
    expect(staffReview).toContain("dateTime=");
    expect([claimant, staffQueue, staffReview].join("\n")).not.toMatch(/inventoryItemId|salt|digest|storedSlots/);
  });

  it("extends private cache and all Claim statuses without adding WebMCP tools", () => {
    const proxy = readFileSync("src/proxy.ts", "utf8");
    const registry = readFileSync("src/features/webmcp/tool-registry.ts", "utf8");
    expect(proxy).toMatch(/startsWith\("\/staff\/"\)/);
    for (const status of [
      "EVIDENCE_REQUIRED", "UNDER_REVIEW", "REJECTED", "LOCKED",
      "APPROVED", "PICKUP_READY", "COLLECTED",
    ]) expect(registry).toContain(status);
    expect(registry).toMatch(/scope\.page === "CLAIM"[\s\S]*return \[\]/);
  });

  it("mints the shared role-switch token and binds the current claim on both claim pages", () => {
    const home = readFileSync("src/app/page.tsx", "utf8");
    const claimPages = [
      "src/app/claimant/claims/[claimId]/page.tsx",
      "src/app/staff/claims/[claimId]/page.tsx",
    ].map((path) => readFileSync(path, "utf8"));

    expect(home).toContain("<DemoRoleBar");
    expect(home).not.toContain("resumeClaimId=");
    for (const source of claimPages) {
      expect(source).toContain("mintRoleSwitchCsrf");
      expect(source).toContain("<DemoRoleBar");
      expect(source).toMatch(/resumeClaimId=\{claimId\}/);
    }
  });
});

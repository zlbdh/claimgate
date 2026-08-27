import { describe, expect, it } from "vitest";
import { assertPickupSafeWebMcp } from "./pickup-webmcp-gate";

const names = `export const CLAIMGATE_TOOL_NAMES = [
  "create_lost_report_draft", "update_lost_report_draft", "list_my_reports",
  "find_candidate_matches", "stage_claim_candidate", "get_claim_status",
  "get_pickup_instructions", "list_pending_claims", "get_claim_review_summary",
] as const;`;

describe("pickup WebMCP closed mutation gate", () => {
  it("accepts the exact nine tools and read-only pickup instructions endpoint", () => {
    expect(() => assertPickupSafeWebMcp(
      names,
      'fetch(`/api/claims/${input.claimId}/pickup-instructions`)',
    )).not.toThrow();
  });

  it.each([
    "generate_pickup_pass",
    "rotate_pickup_credential",
    "complete_pickup",
  ])("rejects a renamed pickup mutation tool %s", (mutationName) => {
    expect(() => assertPickupSafeWebMcp(
      names.replace("get_pickup_instructions", mutationName),
      "",
    )).toThrow(/tool allowlist/);
  });

  it.each([
    "/api/claims/${claimId}/pickup-pass/issue",
    "/api/claims/${claimId}/pickup-pass/reissue",
    "/api/claims/${claimId}/evidence",
    "/api/staff/claims/${claimId}/approve",
    "/api/staff/claims/${claimId}/reject",
    "/api/staff/claims/${claimId}/unlock",
    "/api/staff/claims/${claimId}/handoff",
    "/api/reports/${reportId}/publish",
    "/api/reports/${reportId}/archive",
    "/api/demo/switch-role",
  ])("rejects sensitive write endpoint %s in WebMCP code", (path) => {
    expect(() => assertPickupSafeWebMcp(names, `fetch(\`${path}\`)`))
      .toThrow(/sensitive write endpoint/);
  });
});

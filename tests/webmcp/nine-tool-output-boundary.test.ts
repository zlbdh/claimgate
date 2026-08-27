import { describe, expect, it, vi } from "vitest";
import { createClaimGateTools, type ClaimGateToolName } from "@/features/webmcp/tool-contracts";
import { completeTestExecutor } from "./test-executor";

const cases = [
  ["update_lost_report_draft", "updateDraft", {
    reportId: "r", expectedVersion: 1, patch: { color: "black" }, idempotencyKey: "output-update-000001",
  }, { reportId: "r", status: "DRAFT", version: 2 }],
  ["get_claim_status", "getClaimStatus", { claimId: "c" }, {
    claimId: "c", status: "APPROVED", version: 5, failedAttempts: 0,
    remainingAttempts: 3, evidenceEligible: true, unlockCount: 0,
    rejectionReason: null, nextStep: "Generate pass manually.",
  }],
  ["get_pickup_instructions", "getPickupInstructions", { claimId: "c" }, {
    claimId: "c", deskName: "Desk", hours: "09:00-17:00", passReady: false,
    expiresAtMs: null, generation: 0, status: "APPROVED", claimVersion: 5,
  }],
  ["list_pending_claims", "listPendingClaims", { limit: 1 }, { claims: [{
    claimId: "c", status: "UNDER_REVIEW", failedAttempts: 0,
    waitingDurationMs: 1, hasConflict: false,
    item: { category: "earbuds", area: "library", color: "black" },
  }] }],
  ["get_claim_review_summary", "getClaimReviewSummary", { claimId: "c" }, {
    claim: { claimId: "c", status: "UNDER_REVIEW", version: 2,
      failedAttempts: 0, remainingAttempts: 3, evidenceEligible: true,
      unlockCount: 0, generation: 0 },
    item: { category: "earbuds", area: "library", color: "black", publicDescription: "Case." },
    report: { publicDescription: "Lost case.", version: 2 },
    conflict: { hasConflict: false, conflictCount: 0 }, timeline: [],
  }],
] as const;

describe("Task 9 new tool output boundary", () => {
  it.each(cases)("rejects extra output from %s", async (name, method, input, data) => {
    const executor = completeTestExecutor({
      [method]: vi.fn(async () => ({ ok: true, data: { ...data, extra: "forbidden" } })),
    });
    const tool = createClaimGateTools(executor)[name as ClaimGateToolName];
    await expect(tool.execute(input)).resolves.toEqual({
      ok: false, error: { code: "INTERNAL_ERROR", message: "Internal server error." },
    });
  });

  it("never returns token-like or private fields through pickup metadata", async () => {
    const executor = completeTestExecutor({
      getPickupInstructions: vi.fn(async () => ({ ok: true, data: {
        claimId: "c", deskName: "Desk", hours: "09:00-17:00", passReady: true,
        expiresAtMs: 1000, generation: 1, status: "PICKUP_READY", claimVersion: 6,
        token: "forbidden", digest: "forbidden",
      } })) as never,
    });
    const result = await createClaimGateTools(executor).get_pickup_instructions.execute({ claimId: "c" });
    expect(result).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
    expect(JSON.stringify(result)).not.toMatch(/forbidden|token|digest/i);
  });

  it.each([
    ["create_lost_report_draft", "createDraft", {
      category: "earbuds",
      timeWindow: { from: "2026-08-25T17:00:00.000Z", to: "2026-08-25T19:00:00.000Z" },
      area: "library", color: "black", publicTags: [], publicDescription: "Black case.",
      idempotencyKey: "missing-path-create1",
    }, { reportId: "r", status: "DRAFT", version: 1 }],
    ["stage_claim_candidate", "stageClaim", {
      reportId: "r", candidateHandle: `cgch1.1.2.${"A".repeat(43)}`, expectedVersion: 2,
      idempotencyKey: "missing-path-stage01",
    }, { claimId: "c", status: "EVIDENCE_REQUIRED", version: 1, remainingAttempts: 3 }],
  ] as const)("requires nextPath on successful %s", async (name, method, input, data) => {
    const executor = completeTestExecutor({
      [method]: vi.fn(async () => ({ ok: true, data })),
    });
    await expect(createClaimGateTools(executor)[name].execute(input)).resolves.toMatchObject({
      ok: false, error: { code: "INTERNAL_ERROR" },
    });
  });
});

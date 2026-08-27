import { vi } from "vitest";
import type { ClaimGateToolExecutor } from "@/features/webmcp/tool-contracts";

export function completeTestExecutor(
  overrides: Partial<ClaimGateToolExecutor> = {},
): ClaimGateToolExecutor {
  return {
    createDraft: vi.fn() as never,
    updateDraft: vi.fn() as never,
    listReports: vi.fn() as never,
    findCandidates: vi.fn() as never,
    stageClaim: vi.fn() as never,
    getClaimStatus: vi.fn() as never,
    getPickupInstructions: vi.fn() as never,
    listPendingClaims: vi.fn() as never,
    getClaimReviewSummary: vi.fn() as never,
    ...overrides,
  };
}

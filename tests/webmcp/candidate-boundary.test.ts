import { describe, expect, it, vi } from "vitest";
import {
  createClaimGateTools,
  type ClaimGateToolExecutor,
} from "@/features/webmcp/tool-contracts";
import { validateStageClaimCommand } from "@/features/claims/claim-schema";
import { completeTestExecutor } from "./test-executor";

const canonicalMac = "A".repeat(43);
const stageBase = {
  reportId: "report-public",
  candidateHandle: `cgch1.1.2.${canonicalMac}`,
  expectedVersion: 2,
  idempotencyKey: "candidate-boundary-0001",
};
const invalidHandles = [
  `cgch1.1.2.${"A".repeat(42)}B`,
  `cgch1.9007199254740992.9007199254740993.${canonicalMac}`,
  `cgch1.01.2.${canonicalMac}`,
  `cgch1.2.2.${canonicalMac}`,
  `cgch1.1.902.${canonicalMac}`,
  `cgch1.1.2.${"A".repeat(90)}`,
];

function executor(): ClaimGateToolExecutor {
  return completeTestExecutor({
    stageClaim: vi.fn<ClaimGateToolExecutor["stageClaim"]>(async () => ({
      ok: true,
      data: { claimId: "claim-public", status: "EVIDENCE_REQUIRED", version: 1, remainingAttempts: 3 },
      nextPath: "/claimant/claims/claim-public",
    })),
  });
}

describe("shared canonical candidate handle boundary", () => {
  it.each(invalidHandles)("rejects %s before executor", async (candidateHandle) => {
    const target = executor();
    const result = await createClaimGateTools(target).stage_claim_candidate.execute({
      ...stageBase,
      candidateHandle,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(target.stageClaim).not.toHaveBeenCalled();
  });

  it.each(invalidHandles)("reuses the same syntax boundary in the server command for %s", (candidateHandle) => {
    expect(() => validateStageClaimCommand({ ...stageBase, candidateHandle }))
      .toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("mirrors canonical time and MAC grammar in discovery", () => {
    const schema = createClaimGateTools(executor()).stage_claim_candidate.inputSchema as {
      properties: { candidateHandle: { maxLength: number; pattern: string } };
    };
    expect(schema.properties.candidateHandle.maxLength).toBe(96);
    expect(new RegExp(schema.properties.candidateHandle.pattern).test(stageBase.candidateHandle)).toBe(true);
    expect(new RegExp(schema.properties.candidateHandle.pattern).test(
      `cgch1.1.2.${"A".repeat(42)}B`,
    )).toBe(false);
  });
});

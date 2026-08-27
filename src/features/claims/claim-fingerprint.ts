import type { StageClaimCommand } from "./claim-schema";

export function claimStageFingerprint(input: StageClaimCommand): string {
  return JSON.stringify({
    contract: "ClaimGate/claim-stage/v1",
    method: "POST",
    path: "/api/claims",
    reportId: input.reportId,
    candidateHandle: input.candidateHandle,
    expectedVersion: input.expectedVersion,
  });
}

import { DEMO_IDENTITIES } from "@/shared/demo-identity";
import { DomainError } from "@/shared/domain-error";
import type { ClaimGateRepository } from "@/server/db/repository";
import type { ClaimActorContext } from "@/features/claims/claim-service";

function requireStaff(context: ClaimActorContext): void {
  if (context.actorId !== DEMO_IDENTITIES.STAFF.userId) throw new DomainError("FORBIDDEN");
}

export function createAuditService(dependencies: { repository: ClaimGateRepository }) {
  return Object.freeze({
    listStaffQueue(context: ClaimActorContext) {
      requireStaff(context);
      return dependencies.repository.listStaffReviewQueue(context.demoInstanceId, 50);
    },
    getStaffReview(context: ClaimActorContext, claimId: string) {
      requireStaff(context);
      const review = dependencies.repository.getStaffClaimReview(context.demoInstanceId, claimId);
      const timeline = dependencies.repository.listClaimTimeline(context.demoInstanceId, claimId, 50);
      return Object.freeze({ ...review, timeline: Object.freeze(timeline) });
    },
    getTimeline(context: ClaimActorContext, claimId: string) {
      return dependencies.repository.listClaimTimeline(context.demoInstanceId, claimId, 50);
    },
  });
}

export type AuditService = ReturnType<typeof createAuditService>;

import { z } from "zod";
import { createPickupPassService } from "@/features/claims/pickup-pass-service";
import type { ClaimStatus } from "@/features/claims/claim-state";
import type { AuthenticatedReadContext } from "@/server/http/request-context";
import { DEMO_IDENTITIES } from "@/shared/demo-identity";
import { DomainError } from "@/shared/domain-error";
import type { ReportRouteDependencies } from "./report-route-support";

const publicId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const safePositive = z.number().int().safe().positive();
const safeNonNegative = z.number().int().safe().nonnegative();
const claimStatus = z.enum([
  "EVIDENCE_REQUIRED", "UNDER_REVIEW", "REJECTED", "LOCKED",
  "APPROVED", "PICKUP_READY", "COLLECTED",
]);
const rejectionReason = z.enum(["STAFF_REJECTED", "ITEM_HELD_BY_ANOTHER_CLAIM"]).nullable();
const publicToken = z.string().min(1).max(64);
const publicDescription = z.string().min(1).max(256);

const claimStatusSchema = z.strictObject({
  claimId: publicId,
  status: claimStatus,
  version: safePositive,
  failedAttempts: z.number().int().min(0).max(3),
  remainingAttempts: z.number().int().min(0).max(3),
  evidenceEligible: z.boolean(),
  unlockCount: z.number().int().min(0).max(1),
  rejectionReason,
  nextStep: z.string().min(1).max(128),
});

const pickupInstructionsSchema = z.strictObject({
  claimId: publicId,
  deskName: z.string().min(1).max(128),
  hours: z.string().min(1).max(128),
  passReady: z.boolean(),
  expiresAtMs: safePositive.nullable(),
  generation: safeNonNegative,
  status: z.enum(["APPROVED", "PICKUP_READY", "COLLECTED"]),
  claimVersion: safePositive,
});

const queueSchema = z.strictObject({
  claims: z.array(z.strictObject({
    claimId: publicId,
    status: z.literal("UNDER_REVIEW"),
    failedAttempts: z.number().int().min(0).max(2),
    waitingDurationMs: safeNonNegative,
    hasConflict: z.boolean(),
    item: z.strictObject({ category: publicToken, area: publicToken, color: publicToken }),
  })).max(3),
});

const timelineEntrySchema = z.strictObject({
  action: z.enum([
    "CLAIM_CREATED", "EVIDENCE_INSUFFICIENT", "EVIDENCE_ELIGIBLE", "EVIDENCE_LOCKED",
    "UNLOCKED", "APPROVED", "STAFF_REJECTED", "COMPETING_REJECTED",
    "PASS_ISSUED", "PASS_REISSUED", "HANDOFF_COMPLETED",
  ]),
  actor: z.enum(["claimant", "staff"]),
  result: z.enum([
    "CREATED", "INSUFFICIENT", "ELIGIBLE", "LOCKED", "UNLOCKED", "APPROVED",
    "REJECTED", "ISSUED", "REISSUED", "COLLECTED",
  ]),
  occurredAtMs: safeNonNegative,
});

const staffReviewSchema = z.strictObject({
  claim: z.strictObject({
    claimId: publicId,
    status: claimStatus,
    version: safePositive,
    failedAttempts: z.number().int().min(0).max(3),
    remainingAttempts: z.number().int().min(0).max(3),
    evidenceEligible: z.boolean(),
    unlockCount: z.number().int().min(0).max(1),
    generation: safeNonNegative,
  }),
  item: z.strictObject({
    category: publicToken,
    area: publicToken,
    color: publicToken,
    publicDescription,
  }),
  report: z.strictObject({ publicDescription, version: safePositive }),
  conflict: z.strictObject({ hasConflict: z.boolean(), conflictCount: safeNonNegative }),
  timeline: z.array(timelineEntrySchema).max(5),
});

function parseInternal<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new DomainError("CONFIGURATION_ERROR");
  return Object.freeze(parsed.data);
}

function requireStaff(context: AuthenticatedReadContext): void {
  if (context.userId !== DEMO_IDENTITIES.STAFF.userId) throw new DomainError("FORBIDDEN");
}

function nextStep(status: ClaimStatus, unlockCount: number, role: "CLAIMANT" | "STAFF"): string {
  if (role === "STAFF") {
    switch (status) {
      case "EVIDENCE_REQUIRED": return "Wait for the Claimant to submit private evidence.";
      case "UNDER_REVIEW": return "Review aggregate evidence and decide manually.";
      case "REJECTED": return "This claim is rejected and read-only.";
      case "LOCKED": return unlockCount === 0
        ? "Staff may unlock this claim once manually."
        : "This claim is locked and read-only.";
      case "APPROVED": return "Wait for the Claimant to generate a pickup pass.";
      case "PICKUP_READY": return "Complete the credential handoff manually.";
      case "COLLECTED": return "The handoff is complete.";
    }
  }
  switch (status) {
    case "EVIDENCE_REQUIRED": return "Submit private evidence.";
    case "UNDER_REVIEW": return "Wait for Staff review.";
    case "REJECTED": return "This claim is rejected.";
    case "LOCKED": return unlockCount === 0 ? "Ask Staff to unlock this claim." : "This claim is locked.";
    case "APPROVED": return "Generate a pickup pass.";
    case "PICKUP_READY": return "Present the pickup pass to Staff.";
    case "COLLECTED": return "The item has been collected.";
  }
}

export function createToolApiReadService(dependencies: ReportRouteDependencies) {
  return Object.freeze({
    getClaimStatus(context: AuthenticatedReadContext, claimId: string) {
      const claim = dependencies.repository.getClaim(context.demoInstanceId, claimId);
      if (
        context.userId !== DEMO_IDENTITIES.STAFF.userId
        && claim.claimantActorId !== context.userId
      ) throw new DomainError("NOT_FOUND");
      return parseInternal(claimStatusSchema, {
        claimId: claim.claimId,
        status: claim.status,
        version: claim.version,
        failedAttempts: claim.attempts,
        remainingAttempts: Math.max(0, 3 - claim.attempts),
        evidenceEligible: claim.evidenceEligible,
        unlockCount: claim.unlockCount,
        rejectionReason: claim.rejectionReason,
        nextStep: nextStep(claim.status, claim.unlockCount, context.role),
      });
    },

    getPickupInstructions(context: AuthenticatedReadContext, claimId: string) {
      const instructions = createPickupPassService({
        repository: dependencies.repository,
        keyring: dependencies.keyring,
        now: dependencies.now,
      }).getInstructions({
        demoInstanceId: context.demoInstanceId,
        actorId: context.userId,
        sessionExpiresAt: context.expiresAt,
      }, claimId);
      return parseInternal(pickupInstructionsSchema, { claimId, ...instructions });
    },

    listPendingClaims(context: AuthenticatedReadContext, limit: number) {
      requireStaff(context);
      const claims = dependencies.repository.listStaffReviewQueue(context.demoInstanceId, limit)
        .map((entry) => ({
          claimId: entry.claimId,
          status: "UNDER_REVIEW" as const,
          failedAttempts: entry.failedAttempts,
          waitingDurationMs: entry.waitingDurationMs,
          hasConflict: entry.conflict,
          item: {
            category: entry.item.category,
            area: entry.item.area,
            color: entry.item.color,
          },
        }));
      return parseInternal(queueSchema, { claims });
    },

    getStaffClaimReview(context: AuthenticatedReadContext, claimId: string) {
      requireStaff(context);
      const review = dependencies.repository.getStaffClaimReview(context.demoInstanceId, claimId);
      if (!["UNDER_REVIEW", "APPROVED", "PICKUP_READY"].includes(review.claim.status)) {
        throw new DomainError("STATE_CHANGED");
      }
      const timeline = dependencies.repository
        .listClaimTimeline(context.demoInstanceId, claimId, 50)
        .slice(-5);
      return parseInternal(staffReviewSchema, {
        claim: {
          claimId: review.claim.claimId,
          status: review.claim.status,
          version: review.claim.version,
          failedAttempts: review.claim.failedAttempts,
          remainingAttempts: Math.max(0, 3 - review.claim.failedAttempts),
          evidenceEligible: review.claim.evidenceEligible,
          unlockCount: review.claim.unlockCount,
          generation: review.claim.generation,
        },
        item: {
          category: review.item.category,
          area: review.item.area,
          color: review.item.color,
          publicDescription: review.item.publicDescription,
        },
        report: {
          publicDescription: review.report.publicDescription,
          version: review.report.version,
        },
        conflict: {
          hasConflict: review.conflict.conflict,
          conflictCount: review.conflict.conflictCount,
        },
        timeline,
      });
    },
  });
}

export type ToolApiReadService = ReturnType<typeof createToolApiReadService>;

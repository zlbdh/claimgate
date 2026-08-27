import { DEMO_IDENTITIES, type DemoUserId } from "@/shared/demo-identity";
import { DomainError } from "@/shared/domain-error";
import type { ClaimGateRepository } from "@/server/db/repository";
import type { Keyring } from "@/server/security/keyring";
import { createReportService } from "@/features/reports/report-service";
import { createEvidenceDigester } from "@/features/evidence/evidence-digester";
import { verifyEvidence } from "@/features/evidence/evidence-service";
import { claimStageFingerprint } from "./claim-fingerprint";
import { validateStageClaimCommand, type StageClaimCommand } from "./claim-schema";
import {
  approveFingerprint,
  evidenceSubmissionFingerprint,
  rejectFingerprint,
  unlockFingerprint,
} from "./claim-review-fingerprint";
import {
  validateApproveClaimCommand,
  validateEvidenceSubmission,
  validateStaffClaimCommand,
  type ApproveClaimCommand,
  type EvidenceSubmissionCommand,
  type StaffClaimCommand,
} from "./claim-review-schema";
import type { ClaimDecisionAck, IdempotencyAction } from "@/server/db/repository-types";

export type ClaimActorContext = Readonly<{
  demoInstanceId: string;
  actorId: DemoUserId;
  sessionExpiresAt: number;
}>;

export type ClaimAckDto = Readonly<{
  claimId: string;
  status: "EVIDENCE_REQUIRED";
  version: number;
  remainingAttempts: 3;
  nextPath: string;
}>;

export type ClaimCheckpointDto = Readonly<{
  claimId: string;
  reportId: string;
  status: import("./claim-state").ClaimStatus;
  failedAttempts: number;
  remainingAttempts: number;
  evidenceEligible: boolean;
  unlockCount: number;
  rejectionReason: "STAFF_REJECTED" | "ITEM_HELD_BY_ANOTHER_CLAIM" | null;
  version: number;
  nextStep: string;
}>;

function requireClaimant(context: ClaimActorContext): void {
  if (context.actorId !== DEMO_IDENTITIES.CLAIMANT.userId) throw new DomainError("FORBIDDEN");
}

function requireStaff(context: ClaimActorContext): void {
  if (context.actorId !== DEMO_IDENTITIES.STAFF.userId) throw new DomainError("FORBIDDEN");
}

function requireClaimId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new DomainError("VALIDATION_FAILED");
  }
}

function toStateAck(result: ClaimDecisionAck, staff: boolean) {
  const base = {
    claimId: result.claimId,
    status: result.status,
    version: result.version,
    failedAttempts: result.failedAttempts,
    remainingAttempts: Math.max(0, 3 - result.failedAttempts),
    evidenceEligible: result.evidenceEligible,
    unlockCount: result.unlockCount,
    nextPath: staff
      ? `/staff/claims/${result.claimId}`
      : `/claimant/claims/${result.claimId}`,
  };
  return Object.freeze(result.rejectionReason === null
    ? base
    : { ...base, rejectionReason: result.rejectionReason });
}

function toAck(result: { claimId: string; status: "EVIDENCE_REQUIRED"; version: number }): ClaimAckDto {
  return Object.freeze({
    claimId: result.claimId,
    status: result.status,
    version: result.version,
    remainingAttempts: 3,
    nextPath: `/claimant/claims/${result.claimId}`,
  });
}

export function createClaimService(dependencies: {
  repository: ClaimGateRepository;
  keyring: Keyring;
  now?: () => number;
}) {
  const now = dependencies.now ?? Date.now;
  const evidenceDigester = createEvidenceDigester(dependencies.keyring.getKey("evidence"));
  const runStaffDecision = (
    context: ClaimActorContext,
    claimId: string,
    action: Extract<IdempotencyAction, "claim_approve" | "claim_reject" | "claim_unlock">,
    input: ApproveClaimCommand | StaffClaimCommand,
    fingerprint: string,
    mutation: (repository: ClaimGateRepository) => ClaimDecisionAck,
  ) => {
    requireStaff(context);
    requireClaimId(claimId);
    const result = dependencies.repository.withTransaction((repository) => repository.runIdempotent({
      demoInstanceId: context.demoInstanceId,
      actorId: context.actorId,
      action,
      expectedClaimId: claimId,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint,
    }, () => ({ kind: "claim_state_ack", ...mutation(repository) })));
    if (result.kind !== "claim_state_ack") throw new DomainError("CONFIGURATION_ERROR");
    return toStateAck(result, true);
  };
  return Object.freeze({
    stage(context: ClaimActorContext, untrusted: StageClaimCommand): ClaimAckDto {
      requireClaimant(context);
      const input = validateStageClaimCommand(untrusted);
      const result = dependencies.repository.withTransaction((repository) => repository.runIdempotent({
        demoInstanceId: context.demoInstanceId,
        actorId: context.actorId,
        action: "claim_stage",
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: claimStageFingerprint(input),
      }, () => {
        const report = repository.getLostReport(context.demoInstanceId, input.reportId);
        if (report.ownerActorId !== context.actorId) throw new DomainError("NOT_FOUND");
        if (report.status !== "PUBLISHED" || report.version !== input.expectedVersion) {
          throw new DomainError("STATE_CHANGED");
        }
        const inventoryItemId = createReportService({ repository, keyring: dependencies.keyring, now })
          .resolveCandidate(context, input.reportId, input.candidateHandle);
        const claim = repository.createClaim({
          demoInstanceId: context.demoInstanceId,
          reportId: input.reportId,
          inventoryItemId,
          claimantActorId: context.actorId,
        });
        return {
          kind: "claim_ack",
          claimId: claim.claimId,
          status: "EVIDENCE_REQUIRED",
          version: claim.version,
        };
      }));
      if (result.kind !== "claim_ack") throw new DomainError("CONFIGURATION_ERROR");
      return toAck(result);
    },

    getOwned(context: ClaimActorContext, claimId: string): ClaimCheckpointDto {
      requireClaimant(context);
      requireClaimId(claimId);
      const claim = dependencies.repository.getClaim(context.demoInstanceId, claimId);
      if (claim.claimantActorId !== context.actorId) throw new DomainError("NOT_FOUND");
      return Object.freeze({
        claimId: claim.claimId,
        reportId: claim.reportId,
        status: claim.status,
        failedAttempts: claim.attempts,
        remainingAttempts: Math.max(0, 3 - claim.attempts),
        evidenceEligible: claim.evidenceEligible,
        unlockCount: claim.unlockCount,
        rejectionReason: claim.rejectionReason,
        version: claim.version,
        nextStep: claim.status === "EVIDENCE_REQUIRED"
          ? "Submit private evidence for aggregate verification."
          : claim.status === "LOCKED" && claim.unlockCount === 0
            ? "A Staff reviewer may unlock this claim once."
            : "This claim is read-only at its current stage.",
      });
    },

    submitEvidence(
      context: ClaimActorContext,
      claimId: string,
      untrusted: EvidenceSubmissionCommand,
    ) {
      requireClaimant(context);
      requireClaimId(claimId);
      const input = validateEvidenceSubmission(untrusted);
      const fingerprint = evidenceSubmissionFingerprint(
        dependencies.keyring,
        context.demoInstanceId,
        claimId,
        input,
      );
      const result = dependencies.repository.withTransaction((repository) => repository.runIdempotent({
        demoInstanceId: context.demoInstanceId,
        actorId: context.actorId,
        action: "evidence_submit",
        expectedClaimId: claimId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
      }, () => {
        const evidenceContext = repository.getServerInternalClaimEvidenceContext(
          context.demoInstanceId,
          claimId,
        );
        if (evidenceContext.claim.claimantActorId !== context.actorId) throw new DomainError("NOT_FOUND");
        if (evidenceContext.claim.version !== input.expectedVersion) throw new DomainError("STATE_CHANGED");
        if (evidenceContext.claim.status !== "EVIDENCE_REQUIRED") {
          throw new DomainError("INVALID_STATE_TRANSITION");
        }
        if (evidenceContext.itemStatus !== "AVAILABLE") throw new DomainError("ITEM_UNAVAILABLE");
        const outcome = verifyEvidence({
          digester: evidenceDigester,
          demoInstanceId: context.demoInstanceId,
          itemId: evidenceContext.itemId,
          storedSlots: evidenceContext.slots,
          answers: input.answers,
          priorFailedAttempts: evidenceContext.claim.failedAttempts,
        });
        const ack = repository.recordEvidenceOutcome({
          demoInstanceId: context.demoInstanceId,
          claimId,
          claimantActorId: context.actorId,
          expectedClaimVersion: input.expectedVersion,
          outcome: outcome.outcome,
        });
        return { kind: "claim_state_ack", ...ack };
      }));
      if (result.kind !== "claim_state_ack") throw new DomainError("CONFIGURATION_ERROR");
      return toStateAck(result, false);
    },

    approve(context: ClaimActorContext, claimId: string, untrusted: ApproveClaimCommand) {
      requireStaff(context);
      requireClaimId(claimId);
      const input = validateApproveClaimCommand(untrusted);
      return runStaffDecision(
        context, claimId, "claim_approve", input, approveFingerprint(claimId, input),
        (repository) => repository.approveClaim({
          demoInstanceId: context.demoInstanceId,
          claimId,
          staffActorId: context.actorId,
          expectedClaimVersion: input.expectedClaimVersion,
          expectedItemVersion: input.expectedItemVersion,
        }),
      );
    },

    reject(context: ClaimActorContext, claimId: string, untrusted: StaffClaimCommand) {
      requireStaff(context);
      requireClaimId(claimId);
      const input = validateStaffClaimCommand(untrusted);
      return runStaffDecision(
        context, claimId, "claim_reject", input, rejectFingerprint(claimId, input),
        (repository) => repository.rejectClaim({
          demoInstanceId: context.demoInstanceId, claimId,
          staffActorId: context.actorId, expectedClaimVersion: input.expectedClaimVersion,
        }),
      );
    },

    unlock(context: ClaimActorContext, claimId: string, untrusted: StaffClaimCommand) {
      requireStaff(context);
      requireClaimId(claimId);
      const input = validateStaffClaimCommand(untrusted);
      return runStaffDecision(
        context, claimId, "claim_unlock", input, unlockFingerprint(claimId, input),
        (repository) => repository.unlockClaim({
          demoInstanceId: context.demoInstanceId, claimId,
          staffActorId: context.actorId, expectedClaimVersion: input.expectedClaimVersion,
        }),
      );
    },
  });
}

export type ClaimService = ReturnType<typeof createClaimService>;

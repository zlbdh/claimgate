import { DEMO_IDENTITIES, type DemoUserId } from "@/shared/demo-identity";
import { DomainError } from "@/shared/domain-error";
import type { ClaimGateRepository } from "@/server/db/repository";
import type { Keyring } from "@/server/security/keyring";
import { createReportService } from "@/features/reports/report-service";
import { claimStageFingerprint } from "./claim-fingerprint";
import { validateStageClaimCommand, type StageClaimCommand } from "./claim-schema";

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
  status: "EVIDENCE_REQUIRED";
  attempts: number;
  remainingAttempts: number;
  version: number;
  nextStep: string;
}>;

function requireClaimant(context: ClaimActorContext): void {
  if (context.actorId !== DEMO_IDENTITIES.CLAIMANT.userId) throw new DomainError("FORBIDDEN");
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
      const claim = dependencies.repository.getClaim(context.demoInstanceId, claimId);
      if (claim.claimantActorId !== context.actorId) throw new DomainError("NOT_FOUND");
      if (claim.status !== "EVIDENCE_REQUIRED") throw new DomainError("STATE_CHANGED");
      return Object.freeze({
        claimId: claim.claimId,
        reportId: claim.reportId,
        status: claim.status,
        attempts: claim.attempts,
        remainingAttempts: Math.max(0, 3 - claim.attempts),
        version: claim.version,
        nextStep: "Private evidence is a later manual step. No evidence is requested on this checkpoint.",
      });
    },
  });
}

export type ClaimService = ReturnType<typeof createClaimService>;

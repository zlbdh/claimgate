import { randomBytes as secureRandomBytes } from "node:crypto";
import type { ClaimGateRepository } from "@/server/db/repository";
import type { HandoffAck, PickupIssuanceAction } from "@/server/db/repository-types";
import type { Keyring } from "@/server/security/keyring";
import { DEMO_IDENTITIES } from "@/shared/demo-identity";
import { DomainError } from "@/shared/domain-error";
import type { ClaimActorContext } from "./claim-service";
import { createPickupPassCrypto } from "./pickup-pass-crypto";
import { handoffFingerprint, pickupIssuanceFingerprint } from "./pickup-pass-fingerprint";
import {
  validatePickupHandoff,
  validatePickupIssuance,
  type PickupHandoffCommand,
  type PickupIssuanceCommand,
} from "./pickup-pass-schema";

function requireClaimId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new DomainError("VALIDATION_FAILED");
  }
}

function requireClaimant(context: ClaimActorContext): void {
  if (context.actorId !== DEMO_IDENTITIES.CLAIMANT.userId) throw new DomainError("FORBIDDEN");
}

function requireStaff(context: ClaimActorContext): void {
  if (context.actorId !== DEMO_IDENTITIES.STAFF.userId) throw new DomainError("FORBIDDEN");
}

function publicIssuance(result: ReturnType<ClaimGateRepository["runPickupIssuanceIdempotent"]>) {
  const common = {
    claimId: result.ack.claimId,
    status: result.ack.status,
    claimVersion: result.ack.claimVersion,
    generation: result.ack.generation,
    expiresAtMs: result.ack.expiresAtMs,
  };
  if (result.issuance === "ISSUED") {
    return Object.freeze({ issuance: "ISSUED" as const, ...common, token: result.transientToken });
  }
  return Object.freeze({ issuance: "ALREADY_ISSUED" as const, ...common });
}

export function createPickupPassService(dependencies: {
  repository: ClaimGateRepository;
  keyring: Keyring;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
}) {
  const now = dependencies.now ?? Date.now;
  const pickupCrypto = createPickupPassCrypto(
    dependencies.keyring.getKey("pickup-pass"),
    { randomBytes: dependencies.randomBytes ?? secureRandomBytes },
  );

  const issueAction = (
    action: PickupIssuanceAction,
    context: ClaimActorContext,
    claimId: string,
    untrusted: PickupIssuanceCommand,
  ) => {
    requireClaimant(context);
    requireClaimId(claimId);
    const input = validatePickupIssuance(untrusted);
    const fingerprint = pickupIssuanceFingerprint(action, claimId, input);
    const result = dependencies.repository.withTransaction((repository) =>
      repository.runPickupIssuanceIdempotent({
        demoInstanceId: context.demoInstanceId,
        actorId: context.actorId,
        action,
        expectedClaimId: claimId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
      }, () => {
        const current = repository.getServerInternalPickupContext(context.demoInstanceId, claimId);
        if (current.claimantActorId !== context.actorId) throw new DomainError("NOT_FOUND");
        if (current.claimVersion !== input.expectedClaimVersion) throw new DomainError("STATE_CHANGED");
        const initial = action === "pickup_issue";
        if (initial ? current.claimStatus !== "APPROVED" : current.claimStatus !== "PICKUP_READY") {
          throw new DomainError("INVALID_STATE_TRANSITION");
        }
        if (current.itemStatus !== "HELD") throw new DomainError("ITEM_UNAVAILABLE");
        const currentTime = now();
        let expiresAtMs = Math.min(currentTime + 10 * 60_000, current.instanceExpiresAtMs);
        if (!initial && expiresAtMs === current.expiresAtMs) expiresAtMs -= 1;
        if (!Number.isSafeInteger(currentTime) || expiresAtMs <= currentTime) {
          throw new DomainError("STATE_CHANGED");
        }
        const generation = initial ? 1 : current.generation + 1;
        const issued = pickupCrypto.issue({
          demoInstanceId: context.demoInstanceId, claimId, generation, expiresAtMs,
        });
        const safeAck = repository.issuePickupPass({
          demoInstanceId: context.demoInstanceId,
          claimId,
          claimantActorId: context.actorId,
          action,
          expectedClaimVersion: input.expectedClaimVersion,
          generation,
          expiresAtMs,
          salt: issued.salt,
          digest: issued.digest,
        });
        return { safeAck, transientToken: issued.token };
      }));
    return publicIssuance(result);
  };

  return Object.freeze({
    getInstructions(context: ClaimActorContext, claimId: string) {
      requireClaimant(context);
      requireClaimId(claimId);
      const current = dependencies.repository.getServerInternalPickupContext(
        context.demoInstanceId,
        claimId,
      );
      if (current.claimantActorId !== context.actorId) throw new DomainError("NOT_FOUND");
      if (!["APPROVED", "PICKUP_READY", "COLLECTED"].includes(current.claimStatus)) {
        throw new DomainError("INVALID_STATE_TRANSITION");
      }
      return Object.freeze({
        deskName: "Northbridge Property Desk · Desk 04",
        hours: "09:00–17:00 · Monday–Friday",
        passReady: current.claimStatus === "PICKUP_READY",
        expiresAtMs: current.expiresAtMs,
        generation: current.generation,
        status: current.claimStatus,
        claimVersion: current.claimVersion,
      });
    },
    issue(context: ClaimActorContext, claimId: string, input: PickupIssuanceCommand) {
      return issueAction("pickup_issue", context, claimId, input);
    },
    reissue(context: ClaimActorContext, claimId: string, input: PickupIssuanceCommand) {
      return issueAction("pickup_reissue", context, claimId, input);
    },
    handoff(context: ClaimActorContext, claimId: string, untrusted: PickupHandoffCommand): HandoffAck {
      requireStaff(context);
      requireClaimId(claimId);
      const input = validatePickupHandoff(untrusted);
      const fingerprint = handoffFingerprint(dependencies.keyring, claimId, input);
      const result = dependencies.repository.withTransaction((repository) => repository.runIdempotent({
        demoInstanceId: context.demoInstanceId,
        actorId: context.actorId,
        action: "handoff",
        expectedClaimId: claimId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
      }, () => {
        const current = repository.getServerInternalPickupContext(context.demoInstanceId, claimId);
        if (current.salt === null || current.digest === null || current.expiresAtMs === null) {
          throw new DomainError("CONFIGURATION_ERROR");
        }
        if (current.generation !== input.expectedGeneration) throw new DomainError("STATE_CHANGED");
        const verified = pickupCrypto.verify({
          demoInstanceId: context.demoInstanceId,
          claimId,
          generation: current.generation,
          expiresAtMs: current.expiresAtMs,
          salt: current.salt,
          digest: current.digest,
          token: input.token,
        });
        if (!verified) throw new DomainError("FORBIDDEN");
        if (current.claimStatus === "COLLECTED") {
          if (
            current.claimVersion !== input.expectedClaimVersion + 1
            || current.itemVersion !== input.expectedItemVersion + 1
            || current.reportVersion !== input.expectedReportVersion + 1
            || current.itemStatus !== "RETURNED"
            || current.reportStatus !== "RESOLVED"
            || current.consumedAtMs === null
          ) throw new DomainError("STATE_CHANGED");
          return {
            kind: "handoff_ack", claimId, completion: "ALREADY_COLLECTED",
            claimStatus: "COLLECTED", claimVersion: current.claimVersion,
            itemStatus: "RETURNED", itemVersion: current.itemVersion,
            reportStatus: "RESOLVED", reportVersion: current.reportVersion,
            generation: current.generation,
          };
        }
        if (current.expiresAtMs <= now()) throw new DomainError("FORBIDDEN");
        return repository.completePickupHandoff({
          demoInstanceId: context.demoInstanceId,
          claimId,
          staffActorId: context.actorId,
          expectedClaimVersion: input.expectedClaimVersion,
          expectedItemVersion: input.expectedItemVersion,
          expectedReportVersion: input.expectedReportVersion,
          expectedGeneration: input.expectedGeneration,
        });
      }));
      if (result.kind !== "handoff_ack") throw new DomainError("CONFIGURATION_ERROR");
      return Object.freeze(result);
    },
  });
}

export type PickupPassService = ReturnType<typeof createPickupPassService>;

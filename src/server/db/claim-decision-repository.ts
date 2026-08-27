import { DomainError } from "@/shared/domain-error";
import { listServerInternalEvidenceSlots } from "./evidence-repository";
import { appendClaimEvent } from "./claim-event-repository";
import {
  activeInstance,
  CLAIMANT_ACTOR_ID,
  immediate,
  requireActor,
  requireInteger,
  STAFF_ACTOR_ID,
  stateChanged,
} from "./repository-internal";
import type {
  ApproveClaimInput,
  ClaimDecisionAck,
  EvidenceOutcomeInput,
  RepositoryContext,
  ServerInternalClaimEvidenceContext,
  StaffClaimDecisionInput,
} from "./repository-types";

type InternalClaimRow = {
  claimId: string;
  itemId: string;
  claimantActorId: string;
  status: ClaimDecisionAck["status"];
  attempts: number;
  evidenceEligible: number;
  reviewerActorId: string | null;
  rejectionReason: ClaimDecisionAck["rejectionReason"];
  unlockCount: number;
  version: number;
  itemStatus: "AVAILABLE" | "HELD" | "RETURNED";
  itemVersion: number;
};

const INTERNAL_SELECT = `
  SELECT c.id AS claimId, c.found_item_id AS itemId,
    c.claimant_actor_id AS claimantActorId, c.status, c.attempts,
    c.evidence_eligible AS evidenceEligible, c.reviewer_actor_id AS reviewerActorId,
    c.rejection_reason AS rejectionReason, c.unlock_count AS unlockCount, c.version,
    i.status AS itemStatus, i.version AS itemVersion
  FROM claims c JOIN found_items i
    ON i.demo_instance_id = c.demo_instance_id AND i.id = c.found_item_id
  WHERE c.demo_instance_id = ? AND c.id = ?
`;

function readInternal(context: RepositoryContext, instanceId: string, claimId: string) {
  return context.database.prepare(INTERNAL_SELECT).get(instanceId, claimId) as InternalClaimRow | undefined;
}

function toAck(row: InternalClaimRow): ClaimDecisionAck {
  return Object.freeze({
    claimId: row.claimId,
    status: row.status,
    version: row.version,
    failedAttempts: row.attempts,
    evidenceEligible: row.evidenceEligible === 1,
    unlockCount: row.unlockCount,
    rejectionReason: row.rejectionReason,
  });
}

function requireStaff(input: StaffClaimDecisionInput): void {
  if (requireActor(input.staffActorId) !== STAFF_ACTOR_ID) throw new DomainError("FORBIDDEN");
  requireInteger(input.expectedClaimVersion, true);
}

export function getServerInternalClaimEvidenceContext(
  context: RepositoryContext,
  demoInstanceId: string,
  claimId: string,
): ServerInternalClaimEvidenceContext {
  activeInstance(context, demoInstanceId);
  const row = readInternal(context, demoInstanceId, claimId);
  if (!row) throw new DomainError("NOT_FOUND");
  return Object.freeze({
    itemId: row.itemId,
    itemStatus: row.itemStatus,
    claim: Object.freeze({
      claimId: row.claimId,
      claimantActorId: row.claimantActorId,
      status: row.status,
      version: row.version,
      failedAttempts: row.attempts,
      evidenceEligible: row.evidenceEligible === 1,
      unlockCount: row.unlockCount,
    }),
    slots: Object.freeze(listServerInternalEvidenceSlots(context, demoInstanceId, row.itemId)),
  });
}

export function recordEvidenceOutcome(
  context: RepositoryContext,
  input: EvidenceOutcomeInput,
): ClaimDecisionAck {
  return immediate(context, () => {
    activeInstance(context, input.demoInstanceId);
    if (requireActor(input.claimantActorId) !== CLAIMANT_ACTOR_ID) throw new DomainError("FORBIDDEN");
    requireInteger(input.expectedClaimVersion, true);
    const row = readInternal(context, input.demoInstanceId, input.claimId);
    if (!row || row.version !== input.expectedClaimVersion) stateChanged();
    if (row.claimantActorId !== input.claimantActorId) throw new DomainError("NOT_FOUND");
    if (row.status !== "EVIDENCE_REQUIRED") throw new DomainError("INVALID_STATE_TRANSITION");
    if (row.itemStatus !== "AVAILABLE") throw new DomainError("ITEM_UNAVAILABLE");

    let status = "EVIDENCE_REQUIRED";
    let attempts = row.attempts;
    let eligible = 0;
    let event: "EVIDENCE_INSUFFICIENT" | "EVIDENCE_ELIGIBLE" | "EVIDENCE_LOCKED";
    if (input.outcome === "ELIGIBLE_FOR_REVIEW") {
      status = "UNDER_REVIEW";
      eligible = 1;
      event = "EVIDENCE_ELIGIBLE";
    } else if (input.outcome === "INSUFFICIENT_EVIDENCE" && row.attempts < 2) {
      attempts += 1;
      event = "EVIDENCE_INSUFFICIENT";
    } else if (input.outcome === "LOCKED" && row.attempts === 2) {
      status = "LOCKED";
      attempts = 3;
      event = "EVIDENCE_LOCKED";
    } else {
      throw new DomainError("INVALID_STATE_TRANSITION");
    }
    const result = context.database.prepare(`
      UPDATE claims SET status = ?, attempts = ?, evidence_eligible = ?, version = version + 1
      WHERE demo_instance_id = ? AND id = ? AND version = ?
        AND claimant_actor_id = ? AND status = 'EVIDENCE_REQUIRED'
    `).run(
      status, attempts, eligible, input.demoInstanceId, input.claimId,
      input.expectedClaimVersion, input.claimantActorId,
    );
    if (result.changes !== 1) stateChanged();
    appendClaimEvent(context, input.demoInstanceId, input.claimId, event, input.claimantActorId);
    return toAck(readInternal(context, input.demoInstanceId, input.claimId)!);
  });
}

export function approveClaim(context: RepositoryContext, input: ApproveClaimInput): ClaimDecisionAck {
  return immediate(context, () => {
    activeInstance(context, input.demoInstanceId);
    requireStaff(input);
    requireInteger(input.expectedItemVersion, true);
    const row = readInternal(context, input.demoInstanceId, input.claimId);
    if (!row || row.version !== input.expectedClaimVersion) stateChanged();
    if (row.status !== "UNDER_REVIEW" || row.evidenceEligible !== 1) {
      throw new DomainError("INVALID_STATE_TRANSITION");
    }
    if (row.itemStatus !== "AVAILABLE") throw new DomainError("ITEM_UNAVAILABLE");
    if (row.itemVersion !== input.expectedItemVersion) stateChanged();
    const losers = context.database.prepare(`
      SELECT id FROM claims WHERE demo_instance_id = ? AND found_item_id = ? AND id <> ?
        AND status IN ('EVIDENCE_REQUIRED', 'UNDER_REVIEW', 'LOCKED') ORDER BY id
    `).all(input.demoInstanceId, row.itemId, input.claimId) as Array<{ id: string }>;
    if (context.database.prepare(`
      UPDATE found_items SET status = 'HELD', version = version + 1
      WHERE demo_instance_id = ? AND id = ? AND status = 'AVAILABLE' AND version = ?
    `).run(input.demoInstanceId, row.itemId, input.expectedItemVersion).changes !== 1) stateChanged();
    if (context.database.prepare(`
      UPDATE demo_instances SET catalog_version = catalog_version + 1
      WHERE id = ? AND expires_at_ms > ?
    `).run(input.demoInstanceId, context.now()).changes !== 1) stateChanged();
    if (context.database.prepare(`
      UPDATE claims SET status = 'APPROVED', reviewer_actor_id = 'staff-demo',
        rejection_reason = NULL, version = version + 1
      WHERE demo_instance_id = ? AND id = ? AND status = 'UNDER_REVIEW'
        AND evidence_eligible = 1 AND version = ?
    `).run(input.demoInstanceId, input.claimId, input.expectedClaimVersion).changes !== 1) stateChanged();
    const loserUpdate = context.database.prepare(`
      UPDATE claims SET status = 'REJECTED', reviewer_actor_id = NULL,
        rejection_reason = 'ITEM_HELD_BY_ANOTHER_CLAIM', version = version + 1
      WHERE demo_instance_id = ? AND found_item_id = ? AND id <> ?
        AND status IN ('EVIDENCE_REQUIRED', 'UNDER_REVIEW', 'LOCKED')
    `).run(input.demoInstanceId, row.itemId, input.claimId);
    if (loserUpdate.changes !== losers.length) stateChanged();
    const active = context.database.prepare(`
      SELECT COUNT(*) AS count FROM claims
      WHERE demo_instance_id = ? AND found_item_id = ?
        AND status IN ('EVIDENCE_REQUIRED', 'UNDER_REVIEW', 'LOCKED')
    `).get(input.demoInstanceId, row.itemId) as { count: number };
    if (active.count !== 0) stateChanged();
    appendClaimEvent(context, input.demoInstanceId, input.claimId, "APPROVED", input.staffActorId);
    for (const loser of losers) {
      appendClaimEvent(context, input.demoInstanceId, loser.id, "COMPETING_REJECTED", input.staffActorId);
    }
    return toAck(readInternal(context, input.demoInstanceId, input.claimId)!);
  });
}

export function rejectClaim(context: RepositoryContext, input: StaffClaimDecisionInput): ClaimDecisionAck {
  return immediate(context, () => {
    activeInstance(context, input.demoInstanceId);
    requireStaff(input);
    const row = readInternal(context, input.demoInstanceId, input.claimId);
    if (!row || row.version !== input.expectedClaimVersion) stateChanged();
    if (row.status !== "UNDER_REVIEW" || row.evidenceEligible !== 1) {
      throw new DomainError("INVALID_STATE_TRANSITION");
    }
    if (context.database.prepare(`
      UPDATE claims SET status = 'REJECTED', reviewer_actor_id = 'staff-demo',
        rejection_reason = 'STAFF_REJECTED', version = version + 1
      WHERE demo_instance_id = ? AND id = ? AND status = 'UNDER_REVIEW' AND version = ?
    `).run(input.demoInstanceId, input.claimId, input.expectedClaimVersion).changes !== 1) stateChanged();
    appendClaimEvent(context, input.demoInstanceId, input.claimId, "STAFF_REJECTED", input.staffActorId);
    return toAck(readInternal(context, input.demoInstanceId, input.claimId)!);
  });
}

export function unlockClaim(context: RepositoryContext, input: StaffClaimDecisionInput): ClaimDecisionAck {
  return immediate(context, () => {
    activeInstance(context, input.demoInstanceId);
    requireStaff(input);
    const row = readInternal(context, input.demoInstanceId, input.claimId);
    if (!row || row.version !== input.expectedClaimVersion) stateChanged();
    if (row.status !== "LOCKED" || row.attempts !== 3 || row.unlockCount !== 0) {
      throw new DomainError("INVALID_STATE_TRANSITION");
    }
    if (row.itemStatus !== "AVAILABLE") throw new DomainError("ITEM_UNAVAILABLE");
    if (context.database.prepare(`
      UPDATE claims SET status = 'EVIDENCE_REQUIRED', attempts = 0,
        evidence_eligible = 0, unlock_count = 1, version = version + 1
      WHERE demo_instance_id = ? AND id = ? AND status = 'LOCKED'
        AND attempts = 3 AND unlock_count = 0 AND version = ?
    `).run(input.demoInstanceId, input.claimId, input.expectedClaimVersion).changes !== 1) stateChanged();
    appendClaimEvent(context, input.demoInstanceId, input.claimId, "UNLOCKED", input.staffActorId);
    return toAck(readInternal(context, input.demoInstanceId, input.claimId)!);
  });
}

import { DomainError } from "@/shared/domain-error";
import { assertClaimTransition } from "@/features/claims/claim-state";
import type {
  ClaimRecord,
  CreateClaimInput,
  RepositoryContext,
  UpdateClaimInput,
} from "./repository-types";
import { appendClaimAudit } from "./audit-repository";
import {
  activeInstance,
  assertNoInternalInventoryIdentity,
  requireActor,
  requirePatchKeys,
  immediate,
  stateChanged,
} from "./repository-internal";

type ClaimRow = Omit<ClaimRecord, "evidenceEligible"> & { evidenceEligible: number };
type ClaimCreationReportRow = {
  ownerActorId: string;
  status: string;
};
type ClaimCreationItemRow = { status: string };

function toRecord(row: ClaimRow): ClaimRecord {
  return { ...row, evidenceEligible: row.evidenceEligible === 1 };
}

const CLAIM_SELECT = `
  SELECT id AS claimId, report_id AS reportId, claimant_actor_id AS claimantActorId,
    status, attempts, evidence_eligible AS evidenceEligible,
    reviewer_actor_id AS reviewerActorId, pass_generation AS passGeneration, version
  FROM claims
`;

function getClaim(context: RepositoryContext, demoInstanceId: string, claimId: string): ClaimRecord {
  activeInstance(context, demoInstanceId);
  const row = context.database.prepare(`${CLAIM_SELECT} WHERE demo_instance_id = ? AND id = ?`)
    .get(demoInstanceId, claimId) as ClaimRow | undefined;
  if (!row) throw new DomainError("NOT_FOUND");
  const record = toRecord(row);
  assertNoInternalInventoryIdentity(context, record, "CONFIGURATION_ERROR");
  return record;
}

export function createClaim(context: RepositoryContext, input: CreateClaimInput): ClaimRecord {
  return immediate(context, () => {
    activeInstance(context, input.demoInstanceId);
    const claimantActorId = requireActor(input.claimantActorId);
    if (claimantActorId !== "claimant-demo") throw new DomainError("VALIDATION_FAILED");
    const report = context.database.prepare(`
      SELECT owner_actor_id AS ownerActorId, status
      FROM lost_reports WHERE demo_instance_id = ? AND id = ?
    `).get(input.demoInstanceId, input.reportId) as ClaimCreationReportRow | undefined;
    const item = context.database.prepare(`
      SELECT status FROM found_items WHERE demo_instance_id = ? AND id = ?
    `).get(input.demoInstanceId, input.inventoryItemId) as ClaimCreationItemRow | undefined;
    if (!report || !item) throw new DomainError("NOT_FOUND");
    if (report.ownerActorId !== claimantActorId) throw new DomainError("FORBIDDEN");
    if (report.status !== "PUBLISHED") throw new DomainError("INVALID_STATE_TRANSITION");
    if (item.status !== "AVAILABLE") throw new DomainError("ITEM_UNAVAILABLE");
    const claimId = context.randomId();
    context.database.prepare(`
      INSERT INTO claims (
        demo_instance_id, id, report_id, found_item_id, claimant_actor_id,
        status, attempts, evidence_eligible, pass_generation, version
      ) VALUES (?, ?, ?, ?, ?, 'EVIDENCE_REQUIRED', 0, 0, 0, 1)
    `).run(
      input.demoInstanceId,
      claimId,
      input.reportId,
      input.inventoryItemId,
      input.claimantActorId,
    );
    appendClaimAudit(context, input.demoInstanceId, claimId, "CLAIM_CREATED", claimantActorId);
    return getClaim(context, input.demoInstanceId, claimId);
  });
}

export function updateClaim(context: RepositoryContext, input: UpdateClaimInput): ClaimRecord {
  return immediate(context, () => {
    activeInstance(context, input.demoInstanceId);
    const actorId = requireActor(input.actorId);
    requirePatchKeys(input.patch, ["status", "attempts", "evidenceEligible"]);
    const row = context.database.prepare(`${CLAIM_SELECT} WHERE demo_instance_id = ? AND id = ?`)
      .get(input.demoInstanceId, input.claimId) as ClaimRow | undefined;
    if (!row || row.version !== input.expectedVersion) stateChanged();
    const existing = toRecord(row);
    const next = { ...existing, ...input.patch };
    if (input.patch.status !== undefined) {
      if (!["UNDER_REVIEW", "REJECTED", "LOCKED", "EVIDENCE_REQUIRED"].includes(input.patch.status)) {
        throw new DomainError("INVALID_STATE_TRANSITION");
      }
      assertClaimTransition(existing.status, input.patch.status);
    }
    const result = context.database.prepare(`
      UPDATE claims SET status = ?, attempts = ?, evidence_eligible = ?,
        version = version + 1
      WHERE demo_instance_id = ? AND id = ? AND version = ?
    `).run(
      next.status,
      next.attempts,
      next.evidenceEligible ? 1 : 0,
      input.demoInstanceId,
      input.claimId,
      input.expectedVersion,
    );
    if (result.changes !== 1) stateChanged();
    appendClaimAudit(context, input.demoInstanceId, input.claimId, "CLAIM_UPDATED", actorId);
    return getClaim(context, input.demoInstanceId, input.claimId);
  });
}

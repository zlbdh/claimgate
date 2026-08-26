import { DomainError } from "@/shared/domain-error";
import { assertClaimTransition } from "@/features/claims/claim-state";
import type {
  ClaimRecord,
  CreateClaimInput,
  RepositoryContext,
  UpdateClaimInput,
} from "./repository-types";
import { appendAuditEvent } from "./audit-repository";
import { activeInstance, immediate, stateChanged } from "./repository-internal";

type ClaimRow = Omit<ClaimRecord, "evidenceEligible"> & { evidenceEligible: number };

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
  return toRecord(row);
}

export function createClaim(context: RepositoryContext, input: CreateClaimInput): ClaimRecord {
  return immediate(context, () => {
    activeInstance(context, input.demoInstanceId);
    const report = context.database.prepare(
      "SELECT 1 FROM lost_reports WHERE demo_instance_id = ? AND id = ?",
    ).get(input.demoInstanceId, input.reportId);
    const item = context.database.prepare(
      "SELECT 1 FROM found_items WHERE demo_instance_id = ? AND id = ?",
    ).get(input.demoInstanceId, input.inventoryItemId);
    if (!report || !item) throw new DomainError("NOT_FOUND");
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
    appendAuditEvent(context, input.demoInstanceId, {
      resourceType: "CLAIM",
      resourcePublicId: claimId,
      action: "CLAIM_CREATED",
      actorId: input.claimantActorId,
      result: "SUCCEEDED",
    });
    return getClaim(context, input.demoInstanceId, claimId);
  });
}

export function updateClaim(context: RepositoryContext, input: UpdateClaimInput): ClaimRecord {
  return immediate(context, () => {
    activeInstance(context, input.demoInstanceId);
    const row = context.database.prepare(`${CLAIM_SELECT} WHERE demo_instance_id = ? AND id = ?`)
      .get(input.demoInstanceId, input.claimId) as ClaimRow | undefined;
    if (!row || row.version !== input.expectedVersion) stateChanged();
    const existing = toRecord(row);
    const next = { ...existing, ...input.patch };
    if (input.patch.status !== undefined) {
      assertClaimTransition(existing.status, input.patch.status);
    }
    const result = context.database.prepare(`
      UPDATE claims SET status = ?, attempts = ?, evidence_eligible = ?,
        reviewer_actor_id = ?, pass_generation = ?, version = version + 1
      WHERE demo_instance_id = ? AND id = ? AND version = ?
    `).run(
      next.status,
      next.attempts,
      next.evidenceEligible ? 1 : 0,
      next.reviewerActorId,
      next.passGeneration,
      input.demoInstanceId,
      input.claimId,
      input.expectedVersion,
    );
    if (result.changes !== 1) stateChanged();
    appendAuditEvent(context, input.demoInstanceId, {
      resourceType: "CLAIM",
      resourcePublicId: input.claimId,
      action: "CLAIM_UPDATED",
      actorId: input.actorId,
      result: "SUCCEEDED",
    });
    return getClaim(context, input.demoInstanceId, input.claimId);
  });
}

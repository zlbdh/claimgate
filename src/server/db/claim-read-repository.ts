import { DomainError } from "@/shared/domain-error";
import type { ClaimStatus, ItemStatus, ReportStatus } from "@/features/claims/claim-state";
import {
  activeInstance,
  assertNoInternalInventoryIdentity,
  parseStringArray,
  requireInteger,
} from "./repository-internal";
import type { RepositoryContext } from "./repository-types";

export type ClaimTimelineEntry = Readonly<{
  action: "CLAIM_CREATED" | import("./repository-types").ClaimEvent["eventType"];
  actor: "claimant" | "staff";
  result: "CREATED" | import("./repository-types").ClaimEvent["result"];
  occurredAtMs: number;
}>;

type ItemSummary = Readonly<{
  category: string;
  foundAt: string;
  area: string;
  color: string;
  publicTags: string[];
  publicDescription: string;
}>;

export type StaffQueueEntry = Readonly<{
  claimId: string;
  item: ItemSummary;
  failedAttempts: number;
  waitingDurationMs: number;
  conflict: boolean;
  conflictCount: number;
}>;

export type StaffClaimReview = Readonly<{
  claim: Readonly<{
    claimId: string;
    status: ClaimStatus;
    version: number;
    failedAttempts: number;
    evidenceEligible: boolean;
    unlockCount: number;
    rejectionReason: "STAFF_REJECTED" | "ITEM_HELD_BY_ANOTHER_CLAIM" | null;
  }>;
  item: ItemSummary & Readonly<{ status: ItemStatus; itemVersion: number }>;
  report: Readonly<{
    reportId: string;
    category: string;
    timeWindow: Readonly<{ from: string; to: string }>;
    area: string;
    color: string;
    publicTags: string[];
    publicDescription: string;
    status: ReportStatus;
    version: number;
  }>;
  conflict: Readonly<{ conflict: boolean; conflictCount: number }>;
}>;

type QueueRow = Omit<StaffQueueEntry, "item" | "conflict"> & {
  category: string;
  foundAt: string;
  area: string;
  color: string;
  publicTagsJson: string;
  publicDescription: string;
};

export function listStaffReviewQueue(
  context: RepositoryContext,
  demoInstanceId: string,
  limit: number,
): StaffQueueEntry[] {
  activeInstance(context, demoInstanceId);
  requireInteger(limit, true);
  if (limit > 50) throw new DomainError("VALIDATION_FAILED");
  const rows = context.database.prepare(`
    SELECT c.id AS claimId, c.attempts AS failedAttempts,
      MAX(0, ? - e.occurred_at_ms) AS waitingDurationMs,
      i.category, i.found_at AS foundAt, i.area, i.color,
      i.public_tags_json AS publicTagsJson, i.public_description AS publicDescription,
      (SELECT COUNT(*) FROM claims other
        WHERE other.demo_instance_id = c.demo_instance_id
          AND other.found_item_id = c.found_item_id AND other.id <> c.id
          AND other.status IN ('EVIDENCE_REQUIRED', 'UNDER_REVIEW', 'LOCKED')) AS conflictCount
    FROM claims c JOIN found_items i
      ON i.demo_instance_id = c.demo_instance_id AND i.id = c.found_item_id
    JOIN (
      SELECT demo_instance_id, claim_id, MAX(occurred_at_ms) AS occurred_at_ms
      FROM claim_events WHERE event_type = 'EVIDENCE_ELIGIBLE'
      GROUP BY demo_instance_id, claim_id
    ) e ON e.demo_instance_id = c.demo_instance_id AND e.claim_id = c.id
    WHERE c.demo_instance_id = ? AND c.status = 'UNDER_REVIEW'
    ORDER BY e.occurred_at_ms, c.id LIMIT ?
  `).all(context.now(), demoInstanceId, limit) as QueueRow[];
  const result = rows.map(({ conflictCount, publicTagsJson, ...row }) => Object.freeze({
    claimId: row.claimId,
    item: Object.freeze({
      category: row.category,
      foundAt: row.foundAt,
      area: row.area,
      color: row.color,
      publicTags: parseStringArray(publicTagsJson),
      publicDescription: row.publicDescription,
    }),
    failedAttempts: row.failedAttempts,
    waitingDurationMs: row.waitingDurationMs,
    conflict: conflictCount > 0,
    conflictCount,
  }));
  assertNoInternalInventoryIdentity(context, result, "CONFIGURATION_ERROR");
  return result;
}

type ReviewRow = {
  claimId: string; claimStatus: ClaimStatus; claimVersion: number; failedAttempts: number;
  evidenceEligible: number; unlockCount: number; rejectionReason: StaffClaimReview["claim"]["rejectionReason"];
  itemStatus: ItemStatus; itemVersion: number; category: string; foundAt: string; area: string;
  color: string; itemTagsJson: string; itemDescription: string; reportId: string;
  reportCategory: string; reportArea: string; reportColor: string;
  timeFrom: string; timeTo: string; reportTagsJson: string; reportDescription: string;
  reportStatus: ReportStatus; reportVersion: number; conflictCount: number;
};

export function getStaffClaimReview(
  context: RepositoryContext,
  demoInstanceId: string,
  claimId: string,
): StaffClaimReview {
  activeInstance(context, demoInstanceId);
  const row = context.database.prepare(`
    SELECT c.id AS claimId, c.status AS claimStatus, c.version AS claimVersion,
      c.attempts AS failedAttempts, c.evidence_eligible AS evidenceEligible,
      c.unlock_count AS unlockCount, c.rejection_reason AS rejectionReason,
      i.status AS itemStatus, i.version AS itemVersion, i.category, i.found_at AS foundAt,
      i.area, i.color, i.public_tags_json AS itemTagsJson,
      i.public_description AS itemDescription, r.id AS reportId,
      r.category AS reportCategory, r.area AS reportArea, r.color AS reportColor,
      r.time_from AS timeFrom, r.time_to AS timeTo,
      r.public_tags_json AS reportTagsJson, r.public_description AS reportDescription,
      r.status AS reportStatus, r.version AS reportVersion,
      (SELECT COUNT(*) FROM claims other
        WHERE other.demo_instance_id = c.demo_instance_id
          AND other.found_item_id = c.found_item_id AND other.id <> c.id
          AND other.status IN ('EVIDENCE_REQUIRED', 'UNDER_REVIEW', 'LOCKED')) AS conflictCount
    FROM claims c JOIN found_items i
      ON i.demo_instance_id = c.demo_instance_id AND i.id = c.found_item_id
    JOIN lost_reports r
      ON r.demo_instance_id = c.demo_instance_id AND r.id = c.report_id
    WHERE c.demo_instance_id = ? AND c.id = ?
  `).get(demoInstanceId, claimId) as ReviewRow | undefined;
  if (!row) throw new DomainError("NOT_FOUND");
  const item = Object.freeze({
    category: row.category, foundAt: row.foundAt, area: row.area, color: row.color,
    publicTags: parseStringArray(row.itemTagsJson), publicDescription: row.itemDescription,
    status: row.itemStatus, itemVersion: row.itemVersion,
  });
  const result = Object.freeze({
    claim: Object.freeze({
      claimId: row.claimId, status: row.claimStatus, version: row.claimVersion,
      failedAttempts: row.failedAttempts, evidenceEligible: row.evidenceEligible === 1,
      unlockCount: row.unlockCount, rejectionReason: row.rejectionReason,
    }),
    item,
    report: Object.freeze({
      reportId: row.reportId, category: row.reportCategory,
      timeWindow: Object.freeze({ from: row.timeFrom, to: row.timeTo }),
      area: row.reportArea, color: row.reportColor, publicTags: parseStringArray(row.reportTagsJson),
      publicDescription: row.reportDescription, status: row.reportStatus, version: row.reportVersion,
    }),
    conflict: Object.freeze({ conflict: row.conflictCount > 0, conflictCount: row.conflictCount }),
  });
  assertNoInternalInventoryIdentity(context, result, "CONFIGURATION_ERROR");
  return result;
}

export function listClaimTimeline(
  context: RepositoryContext,
  demoInstanceId: string,
  claimId: string,
  limit: number,
): ClaimTimelineEntry[] {
  activeInstance(context, demoInstanceId);
  requireInteger(limit, true);
  if (limit > 50) throw new DomainError("VALIDATION_FAILED");
  const rows = context.database.prepare(`
    SELECT action, actor, result, occurredAtMs FROM (
      SELECT 'CLAIM_CREATED' AS action, 'claimant' AS actor, 'CREATED' AS result,
        occurred_at_ms AS occurredAtMs, id, 0 AS sourceOrder
      FROM audit_events WHERE demo_instance_id = ? AND claim_id = ? AND action = 'CLAIM_CREATED'
      UNION ALL
      SELECT event_type AS action,
        CASE actor_id WHEN 'claimant-demo' THEN 'claimant' ELSE 'staff' END AS actor,
        result, occurred_at_ms AS occurredAtMs, id, 1 AS sourceOrder
      FROM claim_events WHERE demo_instance_id = ? AND claim_id = ?
    ) ORDER BY occurredAtMs, sourceOrder, id LIMIT ?
  `).all(demoInstanceId, claimId, demoInstanceId, claimId, limit) as ClaimTimelineEntry[];
  if (rows.length === 0) throw new DomainError("NOT_FOUND");
  assertNoInternalInventoryIdentity(context, rows, "CONFIGURATION_ERROR");
  return rows.map((row) => Object.freeze({ ...row }));
}

import type Database from "better-sqlite3";
import type { ItemStatus, ClaimStatus, ReportStatus } from "@/features/claims/claim-state";
import type { PublicFoundItem } from "@/features/inventory/found-item";
import type { TimeWindow } from "@/features/matching/score-candidate";
import type { EvidenceDigester } from "@/features/evidence/evidence-digester";

export type RepositoryContext = {
  database: Database.Database;
  now: () => number;
  randomId: () => string;
  evidenceDigester: EvidenceDigester;
  randomBytes: (size: number) => Buffer;
};

export type DemoInstance = {
  demoInstanceId: string;
  createdAtMs: number;
  expiresAtMs: number;
  catalogVersion: number;
};

export type ServerInternalFoundItem = PublicFoundItem & {
  inventoryItemId: string;
  status: ItemStatus;
  version: number;
};

export type PublicInventoryItem = PublicFoundItem & { status: ItemStatus };

export type LostReportRecord = {
  reportId: string;
  ownerActorId: string;
  category: string;
  timeWindow: TimeWindow;
  area: string;
  color: string;
  publicTags: string[];
  publicDescription: string;
  status: ReportStatus;
  version: number;
};

export type CreateLostReportInput = Omit<LostReportRecord, "reportId" | "status" | "version"> & {
  demoInstanceId: string;
};

export type UpdateLostReportInput = {
  demoInstanceId: string;
  reportId: string;
  expectedVersion: number;
  actorId: string;
  patch: Partial<Pick<
    LostReportRecord,
    "category" | "area" | "color" | "publicTags" | "publicDescription" | "timeWindow"
  >>;
};

export type TransitionLostReportInput = Omit<UpdateLostReportInput, "patch">;

export type UpdateFoundItemInput = {
  demoInstanceId: string;
  inventoryItemId: string;
  expectedVersion: number;
  actorId: string;
  patch: Partial<Pick<
    ServerInternalFoundItem,
    "area" | "color" | "foundAt" | "publicTags" | "publicDescription"
  >>;
};

export type ServerInternalFoundItemMutationResult = ServerInternalFoundItem & {
  catalogVersion: number;
};

export type ClaimRecord = {
  claimId: string;
  reportId: string;
  claimantActorId: string;
  status: ClaimStatus;
  attempts: number;
  evidenceEligible: boolean;
  reviewerActorId: string | null;
  rejectionReason: "STAFF_REJECTED" | "ITEM_HELD_BY_ANOTHER_CLAIM" | null;
  unlockCount: number;
  passGeneration: number;
  version: number;
};

export type ClaimDecisionAck = Readonly<{
  claimId: string;
  status: ClaimStatus;
  version: number;
  failedAttempts: number;
  evidenceEligible: boolean;
  unlockCount: number;
  rejectionReason: "STAFF_REJECTED" | "ITEM_HELD_BY_ANOTHER_CLAIM" | null;
}>;

export type ClaimEvent = Readonly<{
  eventType:
    | "EVIDENCE_INSUFFICIENT"
    | "EVIDENCE_ELIGIBLE"
    | "EVIDENCE_LOCKED"
    | "UNLOCKED"
    | "APPROVED"
    | "STAFF_REJECTED"
    | "COMPETING_REJECTED";
  actorId: "claimant-demo" | "staff-demo";
  result: "INSUFFICIENT" | "ELIGIBLE" | "LOCKED" | "UNLOCKED" | "APPROVED" | "REJECTED";
  occurredAtMs: number;
}>;

export type ServerInternalClaimEvidenceContext = Readonly<{
  itemId: string;
  itemStatus: ItemStatus;
  claim: Readonly<{
    claimId: string;
    claimantActorId: string;
    status: ClaimStatus;
    version: number;
    failedAttempts: number;
    evidenceEligible: boolean;
    unlockCount: number;
  }>;
  slots: readonly import("@/features/evidence/evidence-service").ServerInternalEvidenceSlot[];
}>;

export type EvidenceOutcomeInput = Readonly<{
  demoInstanceId: string;
  claimId: string;
  claimantActorId: string;
  expectedClaimVersion: number;
  outcome: "ELIGIBLE_FOR_REVIEW" | "INSUFFICIENT_EVIDENCE" | "LOCKED";
}>;

export type StaffClaimDecisionInput = Readonly<{
  demoInstanceId: string;
  claimId: string;
  staffActorId: string;
  expectedClaimVersion: number;
}>;

export type ApproveClaimInput = StaffClaimDecisionInput & Readonly<{
  expectedItemVersion: number;
}>;

export type CreateClaimInput = {
  demoInstanceId: string;
  reportId: string;
  inventoryItemId: string;
  claimantActorId: string;
};

export type UpdateClaimInput = {
  demoInstanceId: string;
  claimId: string;
  expectedVersion: number;
  actorId: string;
  patch: Partial<Pick<
    ClaimRecord,
    "status" | "attempts" | "evidenceEligible"
  >>;
};

export type AuditEvent = {
  auditEventId: string;
  resourceType: "INSTANCE" | "REPORT" | "CLAIM";
  resourcePublicId: string | null;
  action:
    | "DEMO_CREATED"
    | "REPORT_CREATED"
    | "REPORT_UPDATED"
    | "INVENTORY_UPDATED"
    | "CLAIM_CREATED"
    | "CLAIM_UPDATED";
  actorId: string;
  result: "SUCCEEDED" | "DENIED";
  occurredAtMs: number;
};

export type IdempotencyAction =
  | "draft_create"
  | "draft_update"
  | "claim_stage"
  | "evidence_submit"
  | "claim_approve"
  | "claim_reject"
  | "claim_unlock";

export type IdempotencyRequest = {
  demoInstanceId: string;
  actorId: string;
  action: IdempotencyAction;
  idempotencyKey: string;
  requestFingerprint: string;
  expectedClaimId?: string;
};

export type ConsumeActionNonceInput = {
  demoInstanceId: string;
  action: string;
  nonceDigest: string;
};

export type IdempotencyResult =
  | {
    kind: "report_ack";
    reportId: string;
    status: "DRAFT";
    version: number;
  }
  | {
    kind: "claim_ack";
    claimId: string;
    status: "EVIDENCE_REQUIRED";
    version: number;
  }
  | {
    kind: "claim_state_ack";
    claimId: string;
    status: ClaimStatus;
    version: number;
    failedAttempts: number;
    evidenceEligible: boolean;
    unlockCount: number;
    rejectionReason: "STAFF_REJECTED" | "ITEM_HELD_BY_ANOTHER_CLAIM" | null;
  };

export type RepositoryOptions = {
  database: Database.Database;
  evidenceDigester: EvidenceDigester;
  randomBytes: (size: number) => Buffer;
  now?: () => number;
  randomId?: () => string;
};

import type { BrowserCandidateDto } from "@/features/reports/report-types";
import type { CanonicalToolError } from "./tool-errors";
import type { ToolInputMap } from "./tool-input-schemas";

export type ToolResult<T> =
  | Readonly<{ ok: true; data: T; nextPath?: string }>
  | Readonly<{ ok: false; error: CanonicalToolError }>;

export type CandidateToolDto = Readonly<{
  candidateHandle: string;
  category: string;
  timeBand: string;
  area: string;
  color: string;
  confidence: "strong" | "possible" | "weak";
  reasons: readonly string[];
  expiresAt: number;
}>;

export type CreateData = Readonly<{ reportId: string; status: "DRAFT"; version: number }>;
export type UpdateData = Readonly<{ reportId: string; status: "DRAFT"; version: number }>;
export type ReportSummary = Readonly<{
  reportId: string;
  category: string;
  timeWindow: Readonly<{ from: string; to: string }>;
  area: string;
  color: string;
  status: "DRAFT" | "PUBLISHED" | "RESOLVED" | "ARCHIVED";
  version: number;
}>;
export type FindData = Readonly<{
  reportVersion: number;
  candidates: readonly CandidateToolDto[];
  message: string;
}>;
export type StageData = Readonly<{
  claimId: string;
  status: "EVIDENCE_REQUIRED";
  version: number;
  remainingAttempts: 3;
}>;
export type ClaimStatusData = Readonly<{
  claimId: string;
  status: "EVIDENCE_REQUIRED" | "UNDER_REVIEW" | "REJECTED" | "LOCKED" | "APPROVED" | "PICKUP_READY" | "COLLECTED";
  version: number;
  failedAttempts: number;
  remainingAttempts: number;
  evidenceEligible: boolean;
  unlockCount: number;
  rejectionReason: "STAFF_REJECTED" | "ITEM_HELD_BY_ANOTHER_CLAIM" | null;
  nextStep: string;
}>;
export type PickupInstructionsData = Readonly<{
  claimId: string;
  deskName: string;
  hours: string;
  passReady: boolean;
  expiresAtMs: number | null;
  generation: number;
  status: "APPROVED" | "PICKUP_READY" | "COLLECTED";
  claimVersion: number;
}>;
export type PendingClaimsData = Readonly<{ claims: readonly Readonly<{
  claimId: string;
  status: "UNDER_REVIEW";
  failedAttempts: number;
  waitingDurationMs: number;
  hasConflict: boolean;
  item: Readonly<{ category: string; area: string; color: string }>;
}>[] }>;
export type ReviewSummaryData = Readonly<{
  claim: Readonly<{
    claimId: string; status: "UNDER_REVIEW" | "APPROVED" | "PICKUP_READY";
    version: number; failedAttempts: number; remainingAttempts: number;
    evidenceEligible: boolean; unlockCount: number; generation: number;
  }>;
  item: Readonly<{ category: string; area: string; color: string; publicDescription: string }>;
  report: Readonly<{ publicDescription: string; version: number }>;
  conflict: Readonly<{ hasConflict: boolean; conflictCount: number }>;
  timeline: readonly Readonly<{
    action: string; actor: "claimant" | "staff"; result: string; occurredAtMs: number;
  }>[];
}>;

export type ClaimGateToolExecutor = Readonly<{
  createDraft(input: ToolInputMap["create_lost_report_draft"]): Promise<ToolResult<CreateData>>;
  updateDraft(input: ToolInputMap["update_lost_report_draft"]): Promise<ToolResult<UpdateData>>;
  listReports(input: ToolInputMap["list_my_reports"]): Promise<ToolResult<{ reports: readonly ReportSummary[] }>>;
  findCandidates(input: ToolInputMap["find_candidate_matches"]): Promise<ToolResult<FindData>>;
  stageClaim(input: ToolInputMap["stage_claim_candidate"]): Promise<ToolResult<StageData>>;
  getClaimStatus(input: ToolInputMap["get_claim_status"]): Promise<ToolResult<ClaimStatusData>>;
  getPickupInstructions(input: ToolInputMap["get_pickup_instructions"]): Promise<ToolResult<PickupInstructionsData>>;
  listPendingClaims(input: ToolInputMap["list_pending_claims"]): Promise<ToolResult<PendingClaimsData>>;
  getClaimReviewSummary(input: ToolInputMap["get_claim_review_summary"]): Promise<ToolResult<ReviewSummaryData>>;
}>;

export type CandidatePublisher = (
  reportId: string,
  reportVersion: number,
  candidates: readonly BrowserCandidateDto[],
) => void;

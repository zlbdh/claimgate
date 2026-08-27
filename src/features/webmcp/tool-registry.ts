import type { ClaimGateToolName } from "./tool-contracts";

type BaseScope = Readonly<{ role: "CLAIMANT" | "STAFF" | "ANONYMOUS" }>;
export type ClaimGateToolScope =
  | (BaseScope & Readonly<{ page: "WORKSPACE" }>)
  | (BaseScope & Readonly<{
    page: "REPORT";
    reportId: string;
    reportStatus: "DRAFT" | "PUBLISHED" | "RESOLVED" | "ARCHIVED";
    reportVersion: number;
    candidateReportVersion?: number;
    candidateCount?: number;
  }>)
  | (BaseScope & Readonly<{
    page: "CLAIM";
    claimId: string;
    claimVersion: number;
    claimStatus:
      | "EVIDENCE_REQUIRED"
      | "UNDER_REVIEW"
      | "REJECTED"
      | "LOCKED"
      | "APPROVED"
      | "PICKUP_READY"
      | "COLLECTED";
  }>)
  | (BaseScope & Readonly<{ page: "STAFF_QUEUE" }>)
  | (BaseScope & Readonly<{ page: "OTHER" }>);

export function toolNamesForScope(scope: ClaimGateToolScope): ClaimGateToolName[] {
  if (scope.role === "STAFF") {
    if (scope.page === "STAFF_QUEUE") return ["list_pending_claims"];
    if (scope.page !== "CLAIM") return [];
    const names: ClaimGateToolName[] = ["get_claim_status"];
    if (["UNDER_REVIEW", "APPROVED", "PICKUP_READY"].includes(scope.claimStatus)) {
      names.push("get_claim_review_summary");
    }
    return names;
  }
  if (scope.role !== "CLAIMANT") return [];
  if (scope.page === "WORKSPACE") {
    return ["create_lost_report_draft", "list_my_reports"];
  }
  if (scope.page === "CLAIM") {
    const names: ClaimGateToolName[] = ["get_claim_status"];
    if (["APPROVED", "PICKUP_READY"].includes(scope.claimStatus)) {
      names.push("get_pickup_instructions");
    }
    return names;
  }
  if (scope.page !== "REPORT") return [];
  if (scope.reportStatus === "DRAFT") return ["update_lost_report_draft", "list_my_reports"];
  if (scope.reportStatus !== "PUBLISHED") return [];
  const names: ClaimGateToolName[] = ["find_candidate_matches", "list_my_reports"];
  if (
    scope.candidateCount !== undefined
    && scope.candidateCount > 0
    && scope.candidateReportVersion === scope.reportVersion
  ) names.push("stage_claim_candidate");
  return names;
}

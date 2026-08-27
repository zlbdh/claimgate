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
    claimStatus:
      | "EVIDENCE_REQUIRED"
      | "UNDER_REVIEW"
      | "REJECTED"
      | "LOCKED"
      | "APPROVED"
      | "PICKUP_READY"
      | "COLLECTED";
  }>)
  | (BaseScope & Readonly<{ page: "OTHER" }>);

export function toolNamesForScope(scope: ClaimGateToolScope): ClaimGateToolName[] {
  if (scope.role !== "CLAIMANT") return [];
  if (scope.page === "WORKSPACE") {
    return ["create_lost_report_draft", "list_my_reports"];
  }
  if (scope.page === "CLAIM") return [];
  if (scope.page !== "REPORT") return [];
  if (scope.reportStatus === "DRAFT") return ["list_my_reports"];
  if (scope.reportStatus !== "PUBLISHED") return [];
  const names: ClaimGateToolName[] = ["find_candidate_matches", "list_my_reports"];
  if (
    scope.candidateCount !== undefined
    && scope.candidateCount > 0
    && scope.candidateReportVersion === scope.reportVersion
  ) names.push("stage_claim_candidate");
  return names;
}

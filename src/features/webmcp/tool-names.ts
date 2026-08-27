export const CLAIMGATE_TOOL_NAMES = Object.freeze([
  "create_lost_report_draft",
  "update_lost_report_draft",
  "list_my_reports",
  "find_candidate_matches",
  "stage_claim_candidate",
  "get_claim_status",
  "get_pickup_instructions",
  "list_pending_claims",
  "get_claim_review_summary",
] as const);

export type ClaimGateToolName = (typeof CLAIMGATE_TOOL_NAMES)[number];

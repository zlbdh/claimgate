const EXPECTED_TOOL_NAMES = Object.freeze([
  "create_lost_report_draft",
  "update_lost_report_draft",
  "list_my_reports",
  "find_candidate_matches",
  "stage_claim_candidate",
  "get_claim_status",
  "get_pickup_instructions",
  "list_pending_claims",
  "get_claim_review_summary",
]);

export function assertPickupSafeWebMcp(
  toolNameSource: string,
  webMcpSource: string,
): void {
  const block = toolNameSource.match(
    /CLAIMGATE_TOOL_NAMES\s*=\s*(?:Object\.freeze\(\s*)?\[([\s\S]*?)\]\s*as const\s*\)?/,
  )?.[1];
  const names = block
    ? [...block.matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]!)
    : [];
  if (JSON.stringify(names) !== JSON.stringify(EXPECTED_TOOL_NAMES)) {
    throw new Error("pickup client check tool allowlist changed");
  }
  if (/(?:\/pickup-pass\/|\/handoff\b|\/approve\b|\/reject\b|\/unlock\b|\/evidence\b|\/publish\b|\/archive\b|\/switch-role\b)/i.test(webMcpSource)) {
    throw new Error("pickup client check found sensitive write endpoint in WebMCP");
  }
}

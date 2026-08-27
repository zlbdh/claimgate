import type { ClaimGateToolName } from "./tool-names";

export function selectClaimGateTool(input: Readonly<{
  request: string;
  availableTools: readonly ClaimGateToolName[];
  untrustedContent?: string;
}>): ClaimGateToolName | null {
  const request = input.request.normalize("NFKC").trim().toLowerCase();
  const available = new Set(input.availableTools);
  const choose = (name: ClaimGateToolName) => available.has(name) ? name : null;
  if (/\b(publish|approve|reject|unlock|handoff|issue.*pass)\b/.test(request)) return null;
  if (/\b(update|change|edit|revise)\b.*\bdraft\b|\bdraft\b.*\b(update|change|edit|revise)\b/.test(request)) {
    return choose("update_lost_report_draft");
  }
  if (/\b(lost|missing)\b.*\b(something|item|property)\b/.test(request)) {
    return choose("create_lost_report_draft");
  }
  if (/\b(find|search|match)\b.*\b(item|items|candidate|candidates|possible)\b/.test(request)) {
    return choose("find_candidate_matches");
  }
  if (/\bclaim\b.*\b(this|candidate|item)\b/.test(request)) {
    return choose("stage_claim_candidate");
  }
  if (/\b(where|pickup|collect)\b/.test(request)) {
    return choose("get_pickup_instructions") ?? choose("get_claim_status");
  }
  if (/\b(waiting|pending|queue)\b/.test(request)) return choose("list_pending_claims");
  if (/\b(summarize|summary|review)\b/.test(request)) return choose("get_claim_review_summary");
  if (/\b(status|claim state)\b/.test(request)) return choose("get_claim_status");
  return null;
}

import type { FoundItem } from "@/features/inventory/found-item";
import { scoreCandidate, type LostReport, type MatchCandidate } from "./score-candidate";

export const MATCH_THRESHOLD = 50;
export const isEligibleScore = (score: number) => score >= MATCH_THRESHOLD;

export function findMatches(report: LostReport, items: readonly FoundItem[], limit = 3): MatchCandidate[] {
  items.forEach((item) => {
    if (Number.isNaN(Date.parse(item.foundAt))) throw new RangeError("Invalid foundAt");
  });
  return items.map((item) => scoreCandidate(report, item)).filter((candidate): candidate is MatchCandidate => candidate !== null && isEligibleScore(candidate.score)).sort((a, b) => b.score - a.score || Date.parse(a.publicSummary.foundAt) - Date.parse(b.publicSummary.foundAt) || a.candidateId.localeCompare(b.candidateId)).slice(0, Math.min(limit, 3));
}

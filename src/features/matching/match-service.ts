import type { FoundItem } from "@/features/inventory/found-item";
import { scoreCandidate, type LostReport, type MatchCandidate } from "./score-candidate";

export function findMatches(report: LostReport, items: readonly FoundItem[], limit = 3): MatchCandidate[] {
  return items.map((item) => scoreCandidate(report, item)).filter((candidate): candidate is MatchCandidate => candidate !== null && candidate.score >= 50).sort((a, b) => b.score - a.score || Date.parse(a.publicSummary.foundAt) - Date.parse(b.publicSummary.foundAt) || a.candidateId.localeCompare(b.candidateId)).slice(0, Math.min(limit, 3));
}

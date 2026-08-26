import type { FoundItem } from "@/features/inventory/found-item";
import { scoreCandidate, type LostReport, type ServerMatchCandidate } from "./score-candidate";

export const MATCH_THRESHOLD = 50;
export const isEligibleScore = (score: number) => score >= MATCH_THRESHOLD;

export function findMatches(report: LostReport, items: readonly FoundItem[], limit = 3): ServerMatchCandidate[] {
  items.forEach((item) => {
    if (Number.isNaN(Date.parse(item.foundAt))) throw new RangeError("Invalid foundAt");
  });
  return items
    .map((item) => scoreCandidate(report, item))
    .filter((candidate): candidate is ServerMatchCandidate => (
      candidate !== null && isEligibleScore(candidate.score)
    ))
    .sort((a, b) => (
      b.score - a.score
      || Date.parse(a.item.foundAt) - Date.parse(b.item.foundAt)
      || a.inventoryItemId.localeCompare(b.inventoryItemId)
    ))
    .slice(0, Math.min(limit, 3));
}

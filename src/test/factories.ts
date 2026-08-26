import type { LostReport } from "@/features/matching/score-candidate";
import type { FoundItem } from "@/features/inventory/found-item";

export function report(overrides: Partial<LostReport> = {}): LostReport {
  return {
    category: "earbuds",
    timeWindow: { from: "2026-08-26T10:00:00.000Z", to: "2026-08-26T11:00:00.000Z" },
    area: "library",
    color: "white",
    publicTags: ["case", "wireless"],
    publicDescription: "small earbuds",
    ...overrides,
  };
}

export function item(overrides: Partial<FoundItem> = {}): FoundItem {
  return {
    inventoryItemId: "candidate-1",
    category: "earbuds",
    foundAt: "2026-08-26T11:30:00.000Z",
    area: "library",
    color: "white",
    publicTags: ["case", "wireless"],
    publicDescription: "small earbuds",
    ...overrides,
  };
}

export function earbudReport(overrides: Partial<LostReport> = {}): LostReport { return report(overrides); }
export function matchingEarbudItem(overrides: Partial<FoundItem> = {}): FoundItem { return item(overrides); }

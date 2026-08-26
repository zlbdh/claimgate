import { describe, expect, it } from "vitest";
import { item, report, earbudReport, matchingEarbudItem } from "@/test/factories";
import { confidenceForScore, scoreCandidate } from "./score-candidate";

describe("scoreCandidate", () => {
  it("rejects a candidate with a different category before scoring", () => {
    expect(scoreCandidate(report({ category: "earbuds" }), item({ category: "wallet" }))).toBeNull();
  });

  it("scores overlapping time windows at 30", () => {
    expect(scoreCandidate(report({ publicTags: ["a", "b", "c", "d", "e"] }), item({ foundAt: "2026-08-26T10:30:00.000Z", publicTags: ["a", "b", "c", "d", "e"] }))?.score).toBe(100);
  });

  it("scores same-day and 24-hour time matches at 20 and 10", () => {
    const base = item({ area: "station", color: "black", publicTags: [] });
    expect(scoreCandidate(report({ area: "park", color: "red", publicTags: [] }), { ...base, foundAt: "2026-08-26T20:00:00.000Z" })?.score).toBe(20);
    expect(scoreCandidate(report({ timeWindow: { from: "2026-08-26T10:00:00.000Z", to: "2026-08-26T11:00:00.000Z" }, area: "park", color: "red", publicTags: [] }), item({ foundAt: "2026-08-27T09:00:00.000Z", area: "station", color: "blue", publicTags: [] }))?.score).toBe(10);
  });

  it("scores exact and adjacent areas, exact and color-family colors, and caps tags", () => {
    expect(scoreCandidate(report({ publicTags: ["a", "b", "c", "d", "e", "f"] }), item({ publicTags: ["a", "b", "c", "d", "e", "f"] }))?.score).toBe(100);
    expect(scoreCandidate(report({ area: "park", color: "red", publicTags: [], timeWindow: { from: "2026-08-20T10:00:00.000Z", to: "2026-08-20T11:00:00.000Z" } }), item({ area: "library", color: "orange", publicTags: [], foundAt: "2026-08-26T11:30:00.000Z" }))?.score).toBe(22);
  });

  it("returns a strong server-internal candidate with only disclosure-safe reasons", () => {
    const result = scoreCandidate(earbudReport({ publicTags: ["a", "b", "c", "d", "e"] }), matchingEarbudItem({ publicTags: ["a", "b", "c", "d", "e"] }));
    expect(result).toMatchObject({
      score: 100,
      confidence: "strong",
      inventoryItemId: "candidate-1",
      timeBand: "within six hours",
    });
    expect(result?.reasons.length).toBeGreaterThan(0);
    expect(result?.reasons.join(" ")).not.toMatch(/\+\d+|wireless|unique_mark/);
  });

  it("keeps the exact confidence boundaries deterministic", () => {
    expect(confidenceForScore(75)).toBe("strong");
    expect(confidenceForScore(74)).toBe("possible");
    expect(confidenceForScore(60)).toBe("possible");
    expect(confidenceForScore(59)).toBe("weak");
  });
});

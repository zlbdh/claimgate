import { describe, expect, it } from "vitest";
import { item, report } from "@/test/factories";
import { findMatches, isEligibleScore } from "./match-service";

describe("findMatches", () => {
  it("returns only candidates at or above 50 and at most the top three", () => {
    const candidates = Array.from({ length: 5 }, (_, index) => item({ candidateId: `candidate-${index}`, foundAt: `2026-08-26T${String(10 + index).padStart(2, "0")}:00:00.000Z`, publicTags: ["case", "wireless"] }));
    expect(findMatches(report(), candidates)).toHaveLength(3);
    expect(findMatches(report(), candidates).every((candidate) => candidate.score >= 50)).toBe(true);
  });

  it("orders ties by foundAt then opaque candidate id", () => {
    const candidates = [
      item({ candidateId: "b", foundAt: "2026-08-26T12:00:00.000Z" }),
      item({ candidateId: "a", foundAt: "2026-08-26T12:00:00.000Z" }),
      item({ candidateId: "c", foundAt: "2026-08-26T11:00:00.000Z" }),
    ];
    expect(findMatches(report(), candidates).map(({ candidateId }) => candidateId)).toEqual(["c", "a", "b"]);
  });

  it("labels 75+ strong, 60-74 possible, and 50-59 weak", () => {
    const base = item({ area: "library", color: "orange", publicTags: ["case", "wireless"] });
    expect(findMatches(report({ area: "park", color: "red", publicTags: [] }), [base])[0]?.confidence).toBe("weak");
    expect(findMatches(report({ area: "park", color: "red", publicTags: ["case", "wireless"] }), [base])[0]?.confidence).toBe("possible");
  });

  it("rejects scores below 50 while retaining exactly 50", () => {
    expect(isEligibleScore(49)).toBe(false);
    expect(isEligibleScore(50)).toBe(true);
    const weak = item({ area: "library", color: "blue", publicTags: [], foundAt: "2026-08-26T20:00:00.000Z" });
    const exact = item({ area: "library", color: "blue", publicTags: ["case"], foundAt: "2026-08-26T20:00:00.000Z" });
    expect(findMatches(report({ area: "library", color: "red", publicTags: [] }), [weak])).toEqual([]);
    expect(findMatches(report({ area: "library", color: "red", publicTags: ["case"] }), [exact])).toHaveLength(1);
  });

  it("fails fast when a candidate has an invalid foundAt", () => {
    expect(() => findMatches(report(), [item({ foundAt: "not-an-iso-date" })])).toThrow("Invalid foundAt");
  });
});

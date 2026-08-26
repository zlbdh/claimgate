import { describe, expect, it } from "vitest";
import { item, report } from "@/test/factories";
import { findMatches } from "./match-service";

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
});

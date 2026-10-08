import { describe, expect, it } from "vitest";
import { normalizeEvidence } from "./normalize-evidence";

describe("Evidence text normalization", () => {
  it.each([
    ["  Blue–Star  ", "blue-star"],
    ["ＢＬＵＥ  STAR", "blue star"],
    ["Blue\u00a0\u2003Star", "blue star"],
    ["BLUE—STAR", "blue-star"],
    ["Blue֊Star", "blue-star"],
    ["Blue〰Star", "blue-star"],
    ["Cafe\u0301", "café"],
  ])("normalizes %j using consistent NFKC, case, dash, and whitespace rules", (input, expected) => {
    expect(normalizeEvidence(input)).toBe(expected);
  });

  it.each([
    undefined,
    null,
    12,
    "",
    "   ",
    "safe\u0000value",
    "safe\u202evalue",
    "safe\ud800value",
    "x".repeat(257),
    "\ufdfa".repeat(257),
  ])("rejects nonstrings, empty values, control characters, surrogates, and oversized values", (input) => {
    expect(() => normalizeEvidence(input)).toThrow(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });
});

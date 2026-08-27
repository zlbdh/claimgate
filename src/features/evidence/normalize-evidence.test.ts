import { describe, expect, it } from "vitest";
import { normalizeEvidence } from "./normalize-evidence";

describe("举证文本规范化", () => {
  it.each([
    ["  Blue–Star  ", "blue-star"],
    ["ＢＬＵＥ  STAR", "blue star"],
    ["Blue\u00a0\u2003Star", "blue star"],
    ["BLUE—STAR", "blue-star"],
    ["Blue֊Star", "blue-star"],
    ["Blue〰Star", "blue-star"],
    ["Cafe\u0301", "café"],
  ])("按同一 NFKC/大小写/破折号/空白规则规范化 %j", (input, expected) => {
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
  ])("拒绝非字符串、空值、控制/代理项和超长值", (input) => {
    expect(() => normalizeEvidence(input)).toThrow(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });
});

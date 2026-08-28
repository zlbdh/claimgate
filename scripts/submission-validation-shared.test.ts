import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error The validator intentionally remains dependency-free JavaScript.
import { isInside } from "./submission-validation-shared.mjs";

describe("isInside path boundaries", () => {
  it("accepts a target inside the same root", () => {
    const root = path.join(process.cwd(), "fixtures", "repo");
    const target = path.join(root, "docs", "submission", "devpost.md");
    expect(isInside(root, target)).toBe(true);
  });

  it("rejects a sibling target on the same volume", () => {
    const base = path.join(process.cwd(), "fixtures");
    const root = path.join(base, "repo");
    const target = path.join(base, "outside", "devpost-evidence.json");
    expect(isInside(root, target)).toBe(false);
  });

  it.skipIf(process.platform !== "win32")("rejects a target on a different Windows volume", () => {
    expect(isInside("D:\\repo", "C:\\Users\\tester\\AppData\\Local\\Temp\\devpost-evidence.json")).toBe(false);
  });

  it.skipIf(process.platform !== "win32")("treats Windows drive letters case-insensitively", () => {
    expect(isInside("d:\\repo", "D:\\repo\\docs\\submission\\devpost.md")).toBe(true);
  });
});

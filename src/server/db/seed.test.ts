import { describe, expect, it } from "vitest";
import { NORTHBRIDGE_FOUND_ITEM_SEEDS } from "./seed";

describe("Northbridge 代码种子", () => {
  it("固定 1 个目标加 6 个同类干扰项，且调用方不能改写后续实例模板", () => {
    expect(NORTHBRIDGE_FOUND_ITEM_SEEDS).toHaveLength(7);
    expect(NORTHBRIDGE_FOUND_ITEM_SEEDS.every((item) => item.category === "earbuds")).toBe(true);
    expect(Object.isFrozen(NORTHBRIDGE_FOUND_ITEM_SEEDS)).toBe(true);
    for (const item of NORTHBRIDGE_FOUND_ITEM_SEEDS) {
      expect(Object.isFrozen(item)).toBe(true);
      expect(Object.isFrozen(item.publicTags)).toBe(true);
      expect(Object.keys(item).sort()).toEqual([
        "area",
        "category",
        "color",
        "foundAt",
        "publicDescription",
        "publicTags",
      ]);
    }
  });
});

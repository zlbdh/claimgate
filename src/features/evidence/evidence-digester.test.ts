import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { createEvidenceDigester, EVIDENCE_SLOTS } from "./evidence-digester";

const KEY = Buffer.alloc(32, 17);
const BASE = {
  demoInstanceId: "instance-a",
  itemId: "item-a",
  slot: "unique_mark" as const,
  salt: Buffer.alloc(16, 23),
  value: "Blue–Star",
};

describe("用途隔离的 evidence HMAC", () => {
  it("冻结三种封闭槽和 digester capability", () => {
    const digester = createEvidenceDigester(KEY);
    expect(EVIDENCE_SLOTS).toEqual([
      "unique_mark",
      "contents_or_accessory",
      "identifier_suffix",
    ]);
    expect(Object.isFrozen(EVIDENCE_SLOTS)).toBe(true);
    expect(Object.isFrozen(digester)).toBe(true);
  });

  it("同一完整上下文确定，等价规范化输入相同，digest 固定 32 bytes", () => {
    const digester = createEvidenceDigester(KEY);
    const first = digester.digest(BASE);
    const second = digester.digest({ ...BASE, value: "  ＢＬＵＥ–ＳＴＡＲ  " });
    expect(first).toHaveLength(32);
    expect(second).toEqual(first);
    first.fill(0);
    expect(digester.digest(BASE)).not.toEqual(first);
  });

  it("instance/item/slot/salt/key 任一变化都会域隔离", () => {
    const baseDigest = createEvidenceDigester(KEY).digest(BASE).toString("hex");
    const variants = [
      createEvidenceDigester(KEY).digest({ ...BASE, demoInstanceId: "instance-b" }),
      createEvidenceDigester(KEY).digest({ ...BASE, itemId: "item-b" }),
      createEvidenceDigester(KEY).digest({ ...BASE, slot: "identifier_suffix" }),
      createEvidenceDigester(KEY).digest({ ...BASE, salt: Buffer.alloc(16, 24) }),
      createEvidenceDigester(Buffer.alloc(32, 18)).digest(BASE),
    ].map((value) => value.toString("hex"));
    expect(new Set([baseDigest, ...variants]).size).toBe(6);
  });

  it("uint32BE 长度前缀消除 delimiter/字段分割歧义", () => {
    const digester = createEvidenceDigester(KEY);
    const left = digester.digest({ ...BASE, demoInstanceId: "a", itemId: "bc" });
    const right = digester.digest({ ...BASE, demoInstanceId: "ab", itemId: "c" });
    expect(left).not.toEqual(right);
  });

  it.each([
    () => createEvidenceDigester(Buffer.alloc(31)),
    () => createEvidenceDigester("x" as never),
    () => createEvidenceDigester(KEY).digest({ ...BASE, salt: Buffer.alloc(15) }),
    () => createEvidenceDigester(KEY).digest({ ...BASE, salt: "x" as never }),
    () => createEvidenceDigester(KEY).digest({ ...BASE, slot: "other" as never }),
    () => createEvidenceDigester(KEY).digest({ ...BASE, itemId: "" }),
  ])("拒绝非 32-byte key、非 16-byte salt 与非法上下文", (operation) => {
    expect(operation).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
  });
});

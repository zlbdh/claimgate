import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  ADVERSARIAL_BUFFER_KINDS,
  adversarialBuffer,
} from "@/test/adversarial-buffer";
import { createEvidenceDigester, EVIDENCE_SLOTS } from "./evidence-digester";

const KEY = Buffer.alloc(32, 17);
const BASE = {
  demoInstanceId: "instance-a",
  itemId: "item-a",
  slot: "unique_mark" as const,
  salt: Buffer.alloc(16, 23),
  value: "Blue–Star",
};

describe("Purpose-separated evidence HMAC", () => {
  it("freezes the three supported slots and digester capability", () => {
    const digester = createEvidenceDigester(KEY);
    expect(EVIDENCE_SLOTS).toEqual([
      "unique_mark",
      "contents_or_accessory",
      "identifier_suffix",
    ]);
    expect(Object.isFrozen(EVIDENCE_SLOTS)).toBe(true);
    expect(Object.isFrozen(digester)).toBe(true);
  });

  it("is deterministic for the full context, treats equivalent normalized inputs alike, and produces 32-byte digests", () => {
    const digester = createEvidenceDigester(KEY);
    const first = digester.digest(BASE);
    const second = digester.digest({ ...BASE, value: "  ＢＬＵＥ–ＳＴＡＲ  " });
    expect(first).toHaveLength(32);
    expect(second).toEqual(first);
    first.fill(0);
    expect(digester.digest(BASE)).not.toEqual(first);
  });

  it("isolates domains when instance, item, slot, salt, or key changes", () => {
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

  it("uint32BE length prefixes eliminate delimiter and field-boundary ambiguity", () => {
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
  ])("rejects keys other than 32 bytes, salts other than 16 bytes, and invalid contexts", (operation) => {
    expect(operation).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
  });

  it.each(ADVERSARIAL_BUFFER_KINDS)("rejects %s evidence keys without executing traps", (kind) => {
    const counter = { count: 0 };
    expect(() => createEvidenceDigester(adversarialBuffer(kind, 32, counter))).toThrow(
      expect.objectContaining({ code: "CONFIGURATION_ERROR" }),
    );
    expect(counter.count).toBe(0);
  });

  it.each(ADVERSARIAL_BUFFER_KINDS)("rejects %s digest salts without executing traps", (kind) => {
    const counter = { count: 0 };
    expect(() => createEvidenceDigester(KEY).digest({
      ...BASE,
      salt: adversarialBuffer(kind, 16, counter),
    })).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
    expect(counter.count).toBe(0);
  });

  it("rejects Uint8Array and isolates subsequent caller mutations", () => {
    expect(() => createEvidenceDigester(new Uint8Array(32) as never)).toThrow(
      expect.objectContaining({ code: "CONFIGURATION_ERROR" }),
    );
    expect(() => createEvidenceDigester(KEY).digest({
      ...BASE,
      salt: new Uint8Array(16) as never,
    })).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));

    const mutableKey = Buffer.alloc(32, 61);
    const mutableSalt = Buffer.alloc(16, 62);
    const digester = createEvidenceDigester(mutableKey);
    const expected = digester.digest({ ...BASE, salt: mutableSalt });
    mutableKey.fill(0);
    mutableSalt.fill(0);
    expect(digester.digest({ ...BASE, salt: Buffer.alloc(16, 62) })).toEqual(expected);
  });
});

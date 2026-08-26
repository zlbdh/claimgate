import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { DomainError } from "@/shared/domain-error";
import { createKeyring, KEY_PURPOSES } from "./keyring";

const FIXED_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

describe("用途隔离 keyring", () => {
  it("从同一固定主密钥稳定派生四个不同用途的 256-bit 子密钥", () => {
    const first = createKeyring(FIXED_MASTER_KEY);
    const second = createKeyring(FIXED_MASTER_KEY);
    const keys = KEY_PURPOSES.map((purpose) => first.getKey(purpose));

    expect(keys).toHaveLength(4);
    expect(keys.every((key) => key.length === 32)).toBe(true);
    expect(second.getKey("evidence")).toEqual(first.getKey("evidence"));
    expect(new Set(keys.map((key) => key.toString("hex"))).size).toBe(4);
  });

  it("返回子密钥副本，调用方不能改变后续派生结果", () => {
    const keyring = createKeyring(FIXED_MASTER_KEY);
    const exposedKey = keyring.getKey("evidence");
    exposedKey.fill(0);

    expect(keyring.getKey("evidence")).not.toEqual(exposedKey);
  });

  it.each([undefined, "not-base64", Buffer.alloc(31, 7).toString("base64")])(
    "拒绝缺失、非规范或不足 256 bit 的主密钥",
    (masterKey) => {
      expect(() => createKeyring(masterKey)).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
    },
  );

  it("配置错误不会序列化输入的主密钥或内部栈", () => {
    const error = new DomainError("CONFIGURATION_ERROR");

    expect(error.toJSON()).toEqual({
      error: { code: "CONFIGURATION_ERROR", message: "The service is not configured correctly." },
    });
    expect(JSON.stringify(error)).not.toContain("stack");
  });
});

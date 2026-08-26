import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./test-harness";

let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

describe("single-use action nonce repository", () => {
  it("接受 canonical immutable Base64URL digest，并把 replay 映射为 FORBIDDEN", () => {
    testDatabase = createTestDatabase();
    const instance = testDatabase.repository.createDemoInstance();
    const nonceDigest = Buffer.alloc(32, 17).toString("base64url");
    expect(() => testDatabase!.repository.consumeActionNonce({
      demoInstanceId: instance.demoInstanceId,
      action: "role_switch",
      nonceDigest,
    })).not.toThrow();
    expect(() => testDatabase!.repository.consumeActionNonce({
      demoInstanceId: instance.demoInstanceId,
      action: "role_switch",
      nonceDigest,
    })).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("在 outer transaction 内消费 32-byte digest，重复返回 FORBIDDEN", () => {
    testDatabase = createTestDatabase();
    const instance = testDatabase.repository.createDemoInstance();
    const nonceDigest = Buffer.alloc(32, 19).toString("base64url");

    testDatabase.repository.withTransaction((repository) => {
      repository.consumeActionNonce({
        demoInstanceId: instance.demoInstanceId,
        action: "role_switch",
        nonceDigest,
      });
    });
    expect(() => testDatabase!.repository.consumeActionNonce({
      demoInstanceId: instance.demoInstanceId,
      action: "role_switch",
      nonceDigest,
    })).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("业务异常回滚 nonce，随后可成功消费", () => {
    testDatabase = createTestDatabase();
    const instance = testDatabase.repository.createDemoInstance();
    const nonceDigest = Buffer.alloc(32, 21).toString("base64url");
    expect(() => testDatabase!.repository.withTransaction((repository) => {
      repository.consumeActionNonce({
        demoInstanceId: instance.demoInstanceId,
        action: "role_switch",
        nonceDigest,
      });
      throw new Error("business failed");
    })).toThrow("business failed");

    expect(() => testDatabase!.repository.consumeActionNonce({
      demoInstanceId: instance.demoInstanceId,
      action: "role_switch",
      nonceDigest,
    })).not.toThrow();
  });

  it.each([
    { action: "unknown", nonceDigest: Buffer.alloc(32).toString("base64url") },
    { action: "role_switch", nonceDigest: Buffer.alloc(31).toString("base64url") },
    { action: "role_switch", nonceDigest: "not-base64url" },
    { action: "role_switch", nonceDigest: Buffer.alloc(33).toString("base64url") },
    { action: "role_switch", nonceDigest: `${Buffer.alloc(32).toString("base64url")}=` },
  ])("严格拒绝 action/digest/clock 非法输入 %#", (invalid) => {
    testDatabase = createTestDatabase();
    const instance = testDatabase.repository.createDemoInstance();
    expect(() => testDatabase!.repository.consumeActionNonce({
      demoInstanceId: instance.demoInstanceId,
      ...invalid,
    } as never)).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("在查询 active instance 前拒绝不安全或负数 clock", () => {
    testDatabase = createTestDatabase();
    const instance = testDatabase.repository.createDemoInstance();
    for (const invalidNow of [-1, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      testDatabase.setNow(invalidNow);
      expect(() => testDatabase!.repository.consumeActionNonce({
        demoInstanceId: instance.demoInstanceId,
        action: "role_switch",
        nonceDigest: Buffer.alloc(32, 25).toString("base64url"),
      })).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    }
  });
});

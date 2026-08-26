import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./test-harness";

const TEST_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

describe("过期演示实例清理脚本", () => {
  it("默认只 dry-run，只有显式 --apply 才级联删除到期实例", () => {
    const now = Date.UTC(2026, 7, 26, 12);
    testDatabase = createTestDatabase(now);
    const expired = testDatabase.repository.createDemoInstance();
    testDatabase.setNow(now + 1);
    const live = testDatabase.repository.createDemoInstance();
    const script = resolve("scripts/reset-expired-demo-instances.mjs");
    const atExpiry = String(expired.expiresAtMs);

    const dryRun = JSON.parse(execFileSync(
      process.execPath,
      [script, testDatabase.databasePath, `--now-ms=${atExpiry}`],
      { encoding: "utf8" },
    )) as { mode: string; expiredInstances: number };
    expect(dryRun).toEqual({ mode: "dry-run", expiredInstances: 1 });
    expect(testDatabase.repository.getDemoInstance(live.demoInstanceId)).toBeDefined();
    expect(testDatabase.database.prepare("SELECT COUNT(*) AS count FROM demo_instances").get())
      .toEqual({ count: 2 });

    const applied = JSON.parse(execFileSync(
      process.execPath,
      [script, testDatabase.databasePath, `--now-ms=${atExpiry}`, "--apply"],
      { encoding: "utf8", env: { ...process.env, CLAIMGATE_HMAC_KEY: TEST_MASTER_KEY } },
    )) as { mode: string; expiredInstances: number };
    expect(applied).toEqual({ mode: "apply", expiredInstances: 1 });
    expect(testDatabase.database.prepare("SELECT COUNT(*) AS count FROM demo_instances").get())
      .toEqual({ count: 1 });
  });

  it("缺少显式数据库路径时拒绝运行", () => {
    const script = resolve("scripts/reset-expired-demo-instances.mjs");
    expect(() => execFileSync(process.execPath, [script], { encoding: "utf8" })).toThrow();
  });

  it.each([
    ["缺少密钥", undefined],
    ["错误密钥", Buffer.alloc(32, 8).toString("base64")],
  ])("--apply 在%s时拒绝删除", (_label, masterKey) => {
    testDatabase = createTestDatabase();
    const expired = testDatabase.repository.createDemoInstance();
    const script = resolve("scripts/reset-expired-demo-instances.mjs");

    expect(() => execFileSync(
      process.execPath,
      [script, testDatabase!.databasePath, `--now-ms=${expired.expiresAtMs}`, "--apply"],
      {
        encoding: "utf8",
        env: { ...process.env, CLAIMGATE_HMAC_KEY: masterKey },
      },
    )).toThrow();
    expect(testDatabase.database.prepare("SELECT COUNT(*) AS count FROM demo_instances").get())
      .toEqual({ count: 1 });
  });

  it("--apply 在 metadata authenticator 被篡改时拒绝删除", () => {
    testDatabase = createTestDatabase();
    const expired = testDatabase.repository.createDemoInstance();
    testDatabase.database.prepare(`
      UPDATE database_metadata SET key_check_authenticator = zeroblob(32)
      WHERE singleton_id = 1
    `).run();
    const script = resolve("scripts/reset-expired-demo-instances.mjs");

    expect(() => execFileSync(
      process.execPath,
      [script, testDatabase!.databasePath, `--now-ms=${expired.expiresAtMs}`, "--apply"],
      {
        encoding: "utf8",
        env: { ...process.env, CLAIMGATE_HMAC_KEY: TEST_MASTER_KEY },
      },
    )).toThrow();
    expect(testDatabase.database.prepare("SELECT COUNT(*) AS count FROM demo_instances").get())
      .toEqual({ count: 1 });
  });
});

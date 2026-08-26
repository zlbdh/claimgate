import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./test-harness";

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
      { encoding: "utf8" },
    )) as { mode: string; expiredInstances: number };
    expect(applied).toEqual({ mode: "apply", expiredInstances: 1 });
    expect(testDatabase.database.prepare("SELECT COUNT(*) AS count FROM demo_instances").get())
      .toEqual({ count: 1 });
  });

  it("缺少显式数据库路径时拒绝运行", () => {
    const script = resolve("scripts/reset-expired-demo-instances.mjs");
    expect(() => execFileSync(process.execPath, [script], { encoding: "utf8" })).toThrow();
  });
});

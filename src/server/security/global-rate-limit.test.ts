import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabaseConnection } from "@/server/db/connection";
import { createTestDatabase, type TestDatabase } from "@/server/db/test-harness";
import {
  APP_GLOBAL_RATE_LIMIT,
  createPersistentGlobalRateLimiter,
} from "./global-rate-limit";

const execFileAsync = promisify(execFile);
const NOW = Date.UTC(2026, 7, 26, 12);
let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

describe("application-global demo_start limiter", () => {
  it("首次消费也拒绝调用方覆盖固定 30/min 策略", () => {
    testDatabase = createTestDatabase(NOW);
    const limiter = createPersistentGlobalRateLimiter({ database: testDatabase.database, now: () => NOW });
    expect(() => limiter.consume({ ...APP_GLOBAL_RATE_LIMIT, limit: 29 }))
      .toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() => limiter.consume({ ...APP_GLOBAL_RATE_LIMIT, windowMs: 59_999 }))
      .toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(testDatabase.database.prepare(`
      SELECT COUNT(*) AS count FROM application_rate_limit_high_water
    `).get()).toEqual({ count: 0 });
  });

  it("schema 拒绝最终 REAL 与非固定 30/min 配置", () => {
    testDatabase = createTestDatabase(NOW);
    const insert = testDatabase.database.prepare(`
      INSERT INTO application_rate_limit_high_water (
        scope, action, high_water_time_ms, limit_value, window_ms
      ) VALUES ('public-demo-entry', 'demo_start', 1, ?, ?)
    `);
    expect(() => insert.run(1.5, 60_000)).toThrow();
    expect(() => insert.run(30, 1.5)).toThrow();
    expect(() => insert.run(29, 60_000)).toThrow();
    expect(() => insert.run(30, 59_999)).toThrow();
    expect(testDatabase.database.prepare(`
      SELECT COUNT(*) AS count FROM application_rate_limit_high_water
    `).get()).toEqual({ count: 0 });
  });

  it("只接受固定 scope/action，30/min 且不创建 demo 行", () => {
    const now = Date.UTC(2026, 7, 26, 12, 0, 30);
    testDatabase = createTestDatabase(now);
    const limiter = createPersistentGlobalRateLimiter({
      database: testDatabase.database,
      now: () => now,
    });

    for (let index = 0; index < APP_GLOBAL_RATE_LIMIT.limit; index += 1) {
      expect(limiter.consume(APP_GLOBAL_RATE_LIMIT)).toEqual({ allowed: true, retryAfterMs: 0 });
    }
    expect(limiter.consume(APP_GLOBAL_RATE_LIMIT)).toEqual({
      allowed: false,
      retryAfterMs: 30_000,
    });
    expect(testDatabase.database.prepare("SELECT COUNT(*) AS count FROM demo_instances").get())
      .toEqual({ count: 0 });
    expect(() => limiter.consume({ ...APP_GLOBAL_RATE_LIMIT, scope: "ip:secret" } as never))
      .toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() => limiter.consume({ ...APP_GLOBAL_RATE_LIMIT, action: "role_switch" } as never))
      .toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() => limiter.consume({ ...APP_GLOBAL_RATE_LIMIT, limit: 29 }))
      .toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() => limiter.consume({ ...APP_GLOBAL_RATE_LIMIT, windowMs: 59_999 }))
      .toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("重开与时钟回拨不重置额度", () => {
    let now = Date.UTC(2026, 7, 26, 12);
    testDatabase = createTestDatabase(now);
    const limiter = createPersistentGlobalRateLimiter({ database: testDatabase.database, now: () => now });
    for (let index = 0; index < 30; index += 1) {
      expect(limiter.consume(APP_GLOBAL_RATE_LIMIT).allowed).toBe(true);
    }
    now += 120_000;
    for (let index = 0; index < 30; index += 1) {
      expect(limiter.consume(APP_GLOBAL_RATE_LIMIT).allowed).toBe(true);
    }

    const reopened = openDatabaseConnection(testDatabase.databasePath);
    const afterRestart = createPersistentGlobalRateLimiter({ database: reopened, now: () => now });
    now -= 60_000;
    expect(afterRestart.consume(APP_GLOBAL_RATE_LIMIT).allowed).toBe(false);
    reopened.close();
  });

  it("多连接争用时总允许数不超过 limit", async () => {
    const now = Date.UTC(2026, 7, 26, 12, 0, 30);
    testDatabase = createTestDatabase(now);
    const moduleUrl = pathToFileURL(resolve("src/server/security/global-rate-limit.ts")).href;
    const limiter = createPersistentGlobalRateLimiter({ database: testDatabase.database, now: () => now });
    for (let index = 0; index < 27; index += 1) limiter.consume(APP_GLOBAL_RATE_LIMIT);
    const worker = `
      import Database from "better-sqlite3";
      import limiterModule from ${JSON.stringify(moduleUrl)};
      const { createPersistentGlobalRateLimiter, APP_GLOBAL_RATE_LIMIT } = limiterModule;
      const [path, nowText] = process.argv.slice(1);
      const database = new Database(path, { timeout: 5000 });
      database.pragma("foreign_keys = ON");
      const limiter = createPersistentGlobalRateLimiter({ database, now: () => Number(nowText) });
      const result = limiter.consume(APP_GLOBAL_RATE_LIMIT);
      database.close();
      process.stdout.write(JSON.stringify(result));
    `;
    const calls = Array.from({ length: 8 }, () => execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", worker, testDatabase!.databasePath, String(now)],
      { cwd: process.cwd() },
    ));
    const results = await Promise.all(calls);
    expect(results.map(({ stdout }) => JSON.parse(stdout) as { allowed: boolean })
      .filter(({ allowed }) => allowed)).toHaveLength(3);
  }, 30_000);
});

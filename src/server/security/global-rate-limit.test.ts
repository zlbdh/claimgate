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
  it("after 2,000 windows, the bucket has at most one row and high-water has exactly one row", () => {
    let now = NOW;
    testDatabase = createTestDatabase(now);
    const limiter = createPersistentGlobalRateLimiter({ database: testDatabase.database, now: () => now });
    for (let window = 0; window < 2_000; window += 1) {
      now = NOW + window * 60_000;
      expect(limiter.consume().allowed).toBe(true);
    }
    expect(testDatabase!.database.prepare(`
      SELECT COUNT(*) AS count FROM application_rate_limit_buckets
    `).get()).toEqual({ count: 1 });
    expect(testDatabase.database.prepare(`
      SELECT COUNT(*) AS count FROM application_rate_limit_high_water
    `).get()).toEqual({ count: 1 });
  }, 15_000);

  it("the public consume method is a zero-argument fixed-policy capability", () => {
    testDatabase = createTestDatabase(NOW);
    const limiter = createPersistentGlobalRateLimiter({ database: testDatabase.database, now: () => NOW });
    expect(limiter.consume.length).toBe(0);
    expect(Object.isFrozen(APP_GLOBAL_RATE_LIMIT)).toBe(true);
    expect(limiter.consume()).toEqual({ allowed: true, retryAfterMs: 0 });
  });

  it("the schema rejects final REAL values and configurations other than the fixed 30/min policy", () => {
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

  it("outer mutation rollback restores pruning, bucket, and high-water together", () => {
    testDatabase = createTestDatabase(NOW);
    const limiter = createPersistentGlobalRateLimiter({ database: testDatabase.database, now: () => NOW });
    expect(() => testDatabase!.repository.withTransaction(() => {
      expect(limiter.consume().allowed).toBe(true);
      throw new Error("outer rollback");
    })).toThrow("outer rollback");
    expect(testDatabase.database.prepare(`
      SELECT COUNT(*) AS count FROM application_rate_limit_buckets
    `).get()).toEqual({ count: 0 });
    expect(testDatabase.database.prepare(`
      SELECT COUNT(*) AS count FROM application_rate_limit_high_water
    `).get()).toEqual({ count: 0 });
  });

  it("accepts only the fixed scope/action at 30/min without creating demo rows", () => {
    const now = Date.UTC(2026, 7, 26, 12, 0, 30);
    testDatabase = createTestDatabase(now);
    const limiter = createPersistentGlobalRateLimiter({
      database: testDatabase.database,
      now: () => now,
    });

    for (let index = 0; index < APP_GLOBAL_RATE_LIMIT.limit; index += 1) {
      expect(limiter.consume()).toEqual({ allowed: true, retryAfterMs: 0 });
    }
    expect(limiter.consume()).toEqual({
      allowed: false,
      retryAfterMs: 30_000,
    });
    expect(testDatabase.database.prepare(`
      SELECT request_count AS requestCount FROM application_rate_limit_buckets
    `).get()).toEqual({ requestCount: 30 });
    expect(testDatabase.database.prepare(`
      SELECT COUNT(*) AS count FROM application_rate_limit_buckets
    `).get()).toEqual({ count: 1 });
    expect(testDatabase.database.prepare("SELECT COUNT(*) AS count FROM demo_instances").get())
      .toEqual({ count: 0 });
  });

  it("reopening and clock rollback do not reset the quota", () => {
    let now = Date.UTC(2026, 7, 26, 12);
    testDatabase = createTestDatabase(now);
    const limiter = createPersistentGlobalRateLimiter({ database: testDatabase.database, now: () => now });
    for (let index = 0; index < 30; index += 1) {
      expect(limiter.consume().allowed).toBe(true);
    }
    now += 120_000;
    for (let index = 0; index < 30; index += 1) {
      expect(limiter.consume().allowed).toBe(true);
    }

    const reopened = openDatabaseConnection(testDatabase.databasePath);
    const afterRestart = createPersistentGlobalRateLimiter({ database: reopened, now: () => now });
    now -= 60_000;
    expect(afterRestart.consume().allowed).toBe(false);
    reopened.close();
  });

  it("competing connections never exceed the total allowance", async () => {
    const now = Date.UTC(2026, 7, 26, 12, 0, 30);
    testDatabase = createTestDatabase(now);
    const moduleUrl = pathToFileURL(resolve("src/server/security/global-rate-limit.ts")).href;
    const limiter = createPersistentGlobalRateLimiter({ database: testDatabase.database, now: () => now });
    for (let index = 0; index < 27; index += 1) limiter.consume();
    const worker = `
      import Database from "better-sqlite3";
      import limiterModule from ${JSON.stringify(moduleUrl)};
      const { createPersistentGlobalRateLimiter } = limiterModule;
      const [path, nowText] = process.argv.slice(1);
      const database = new Database(path, { timeout: 5000 });
      database.pragma("foreign_keys = ON");
      const limiter = createPersistentGlobalRateLimiter({ database, now: () => Number(nowText) });
      const result = limiter.consume();
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
    expect(testDatabase!.database.prepare(`
      SELECT COUNT(*) AS count, MAX(request_count) AS requestCount
      FROM application_rate_limit_buckets
    `).get()).toEqual({ count: 1, requestCount: 30 });
  }, 30_000);
});

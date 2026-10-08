import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabaseConnection } from "@/server/db/connection";
import { createTestDatabase, type TestDatabase } from "@/server/db/test-harness";
import { createPersistentRateLimiter } from "./rate-limit";

const execFileAsync = promisify(execFile);
let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

function setup(now = Date.UTC(2026, 7, 26, 12)) {
  testDatabase = createTestDatabase(now);
  const instance = testDatabase.repository.createDemoInstance();
  return { test: testDatabase, instance };
}

describe("Persistent SQLite fixed-window rate limiting", () => {
  it("allows exactly limit requests and returns the strict allowed/retryAfterMs shape", () => {
    const now = Date.UTC(2026, 7, 26, 12, 0, 30);
    const { test, instance } = setup(now);
    const limiter = createPersistentRateLimiter({ database: test.database, now: () => now });
    const input = {
      demoInstanceId: instance.demoInstanceId,
      actorId: "claimant-demo",
      action: "match_find",
      limit: 2,
      windowMs: 60_000,
    } as const;

    expect(limiter.consume(input)).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(limiter.consume(input)).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(limiter.consume(input)).toEqual({ allowed: false, retryAfterMs: 30_000 });
    expect(Object.keys(limiter.consume(input)).sort()).toEqual(["allowed", "retryAfterMs"]);
  });

  it.each([
    { limit: 0, windowMs: 1 },
    { limit: 1, windowMs: 0 },
    { limit: 1.5, windowMs: 1 },
    { limit: 1, windowMs: Number.POSITIVE_INFINITY },
  ])("rejects invalid integer boundaries %#", ({ limit, windowMs }) => {
    const { test, instance } = setup();
    const limiter = createPersistentRateLimiter({ database: test.database, now: () => Date.now() });
    expect(() => limiter.consume({
      demoInstanceId: instance.demoInstanceId,
      actorId: "actor",
      action: "action",
      limit,
      windowMs,
    })).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("preserves counts across reopened connections and allows requests again after the window changes", () => {
    let now = Date.UTC(2026, 7, 26, 12, 0, 59, 999);
    const { test, instance } = setup(now);
    const input = {
      demoInstanceId: instance.demoInstanceId,
      actorId: "claimant-demo",
      action: "draft_create",
      limit: 1,
      windowMs: 60_000,
    } as const;
    expect(createPersistentRateLimiter({ database: test.database, now: () => now }).consume(input).allowed)
      .toBe(true);

    const reopened = openDatabaseConnection(test.databasePath);
    const afterRestart = createPersistentRateLimiter({ database: reopened, now: () => now });
    expect(afterRestart.consume(input)).toEqual({ allowed: false, retryAfterMs: 1 });
    now += 1;
    expect(afterRestart.consume(input)).toEqual({ allowed: true, retryAfterMs: 0 });
    reopened.close();
  });

  it("independent Node processes competing for one file never exceed the total allowance", async () => {
    const now = Date.UTC(2026, 7, 26, 12, 0, 30);
    const { test, instance } = setup(now);
    const moduleUrl = pathToFileURL(resolve("src/server/security/rate-limit.ts")).href;
    const worker = `
      import Database from "better-sqlite3";
      import rateLimitModule from ${JSON.stringify(moduleUrl)};
      const { createPersistentRateLimiter } = rateLimitModule;
      const [path, instanceId, nowText] = process.argv.slice(1);
      const database = new Database(path, { timeout: 5000 });
      database.pragma("foreign_keys = ON");
      const result = createPersistentRateLimiter({ database, now: () => Number(nowText) }).consume({
        demoInstanceId: instanceId, actorId: "claimant-demo", action: "match_find",
        limit: 3, windowMs: 60000,
      });
      database.close();
      process.stdout.write(JSON.stringify(result));
    `;
    const calls = Array.from({ length: 8 }, () => execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", worker, test.databasePath, instance.demoInstanceId, String(now)],
      { cwd: process.cwd() },
    ));
    const results = await Promise.all(calls);
    const parsed = results.map(({ stdout }) => JSON.parse(stdout) as { allowed: boolean });

    expect(parsed.filter((result) => result.allowed)).toHaveLength(3);
    const persisted = test.database.prepare(`
      SELECT request_count AS requestCount FROM rate_limit_buckets
      WHERE demo_instance_id = ? AND actor_id = ? AND action = ?
    `).get(instance.demoInstanceId, "claimant-demo", "match_find") as { requestCount: number };
    expect(persisted.requestCount).toBe(3);
  }, 30_000);
});

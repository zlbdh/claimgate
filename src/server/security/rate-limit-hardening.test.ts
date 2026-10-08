import { afterEach, describe, expect, it } from "vitest";
import { openDatabaseConnection } from "@/server/db/connection";
import { createTestDatabase, type TestDatabase } from "@/server/db/test-harness";
import { createPersistentRateLimiter, RATE_LIMIT_ACTIONS } from "./rate-limit";

let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

const RATE_ACTIONS = [
  "role_switch", "draft_create", "draft_update", "report_publish",
  "report_archive", "claim_stage", "evidence_submit", "claim_approve", "claim_reject",
  "claim_unlock", "pickup_issue", "pickup_reissue", "handoff", "match_find",
] as const;

function setup(initialNow = Date.UTC(2026, 7, 26, 12)) {
  testDatabase = createTestDatabase(initialNow);
  return {
    test: testDatabase,
    instance: testDatabase.repository.createDemoInstance(),
  };
}

describe("Closed persistent rate-limit inputs and time high-water mark", () => {
  it("the instance limiter neither advertises nor accepts pre-instance demo_start", () => {
    const { test, instance } = setup();
    const limiter = createPersistentRateLimiter({ database: test.database, now: () => Date.now() });
    expect(RATE_LIMIT_ACTIONS).toEqual(RATE_ACTIONS);
    expect(RATE_LIMIT_ACTIONS).not.toContain("demo_start");
    expect(() => limiter.consume({
      demoInstanceId: instance.demoInstanceId,
      actorId: "claimant-demo",
      action: "demo_start",
      limit: 1,
      windowMs: 60_000,
    })).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() => test.database.prepare(`
      INSERT INTO rate_limit_buckets (
        demo_instance_id, actor_id, action, window_start_ms, request_count
      ) VALUES (?, 'claimant-demo', 'demo_start', 0, 1)
    `).run(instance.demoInstanceId)).toThrow();
  });

  it("accepts only the fixed action matrix and actor identities", () => {
    const now = Date.UTC(2026, 7, 26, 12);
    const { test, instance } = setup(now);
    const limiter = createPersistentRateLimiter({ database: test.database, now: () => now });
    for (const action of RATE_ACTIONS) {
      expect(limiter.consume({
        demoInstanceId: instance.demoInstanceId,
        actorId: "claimant-demo",
        action,
        limit: 1,
        windowMs: 60_000,
      })).toEqual({ allowed: true, retryAfterMs: 0 });
    }

    for (const invalid of [
      { actorId: "Claimant-Demo", action: "match_find" },
      { actorId: "claimant-demo; cookie=session", action: "match_find" },
      { actorId: "", action: "match_find" },
      { actorId: "x".repeat(100_000), action: "match_find" },
      { actorId: 7 as never, action: "match_find" },
      { actorId: "claimant-demo", action: { raw: "match_find" } as never },
      { actorId: "claimant-demo", action: "find-candidates" },
      { actorId: "claimant-demo", action: "match_find_unknown" },
    ]) {
      expect(() => limiter.consume({
        demoInstanceId: instance.demoInstanceId,
        ...invalid,
        limit: 1,
        windowMs: 60_000,
      })).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    }
    const stored = test.database.prepare(`
      SELECT actor_id AS actorId, action FROM rate_limit_buckets ORDER BY actor_id, action
    `).all() as Array<{ actorId: string; action: string }>;
    expect(stored.every(({ actorId, action }) =>
      ["claimant-demo", "staff-demo"].includes(actorId)
      && RATE_ACTIONS.includes(action as (typeof RATE_ACTIONS)[number]))).toBe(true);
    expect(JSON.stringify(stored)).not.toMatch(/cookie|session|100000/);
  });

  it.each([
    { limit: Number.MAX_SAFE_INTEGER + 1, windowMs: 60_000 },
    { limit: 1, windowMs: Number.MAX_SAFE_INTEGER + 1 },
    { limit: 1_001, windowMs: 60_000 },
    { limit: 1, windowMs: 86_400_001 },
  ])("rejects unsafe integers and configurations above the maximum %#", ({ limit, windowMs }) => {
    const { test, instance } = setup();
    const limiter = createPersistentRateLimiter({ database: test.database, now: () => Date.now() });
    expect(() => limiter.consume({
      demoInstanceId: instance.demoInstanceId,
      actorId: "claimant-demo",
      action: "match_find",
      limit,
      windowMs,
    })).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("clock rollback uses the persistent high-water mark without reissuing historical-window quota", () => {
    let now = Date.UTC(2026, 7, 26, 12, 0);
    const { test, instance } = setup(now);
    const input = {
      demoInstanceId: instance.demoInstanceId,
      actorId: "claimant-demo",
      action: "match_find",
      limit: 1,
      windowMs: 60_000,
    } as const;
    const limiter = createPersistentRateLimiter({ database: test.database, now: () => now });
    expect(limiter.consume(input).allowed).toBe(true);
    now += 120_000;
    expect(limiter.consume(input).allowed).toBe(true);

    const reopened = openDatabaseConnection(test.databasePath);
    const afterRestart = createPersistentRateLimiter({ database: reopened, now: () => now });
    now -= 60_000;
    expect(afterRestart.consume(input).allowed).toBe(false);
    now += 120_000;
    expect(afterRestart.consume(input).allowed).toBe(true);
    reopened.close();
  });
});

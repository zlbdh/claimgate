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

describe("Expired demo instance cleanup script", () => {
  it("defaults to dry-run; only explicit --apply cascades deletion of expired instances", () => {
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

  it("refuses to run without an explicit database path", () => {
    const script = resolve("scripts/reset-expired-demo-instances.mjs");
    expect(() => execFileSync(process.execPath, [script], { encoding: "utf8" })).toThrow();
  });

  it.each([
    ["missing key", undefined],
    ["wrong key", Buffer.alloc(32, 8).toString("base64")],
  ])("--apply refuses deletion with %s", (_label, masterKey) => {
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

  it("--apply refuses deletion when the metadata authenticator is tampered with", () => {
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

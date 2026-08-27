import { afterEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./test-harness";

let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

function metadataVersion(): number {
  return (testDatabase!.database.prepare(
    "SELECT schema_version AS version FROM database_metadata WHERE singleton_id = 1",
  ).get() as { version: number }).version;
}

function claimColumns(): string[] {
  return (testDatabase!.database.pragma("table_info(claims)") as Array<{ name: string }>)
    .map(({ name }) => name);
}

function expectConstraintViolation(operation: () => unknown): void {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  expect(String((caught as Error).message)).not.toMatch(/no such column|has no column/i);
}

describe("schema v5 claim review invariants", () => {
  it("creates schema v5 with the review columns, redacted events, and closed indexes", () => {
    testDatabase = createTestDatabase();
    expect(metadataVersion()).toBe(5);
    expect(claimColumns()).toEqual(expect.arrayContaining(["unlock_count", "rejection_reason"]));
    expect(testDatabase.database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'claim_events'",
    ).get()).toEqual({ name: "claim_events" });
    const winnerIndex = testDatabase.database.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'index' AND name = 'claims_single_winner_item_idx'
    `).get() as { sql: string };
    expect(winnerIndex.sql).toContain("'COLLECTED'");
    expect(testDatabase.database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'claims_single_approved_item_idx'
    `).get()).toBeUndefined();
  });

  it.each([
    ["attempts text", "'not-an-integer'", "0", "NULL", "NULL", "0"],
    ["attempts below range", "-1", "0", "NULL", "NULL", "0"],
    ["attempts above range", "4", "0", "NULL", "NULL", "0"],
    ["unlock text", "0", "0", "NULL", "NULL", "'not-an-integer'"],
    ["unlock above one", "0", "0", "NULL", "NULL", "2"],
    ["eligible mismatch", "0", "1", "NULL", "NULL", "0"],
    ["reviewer mismatch", "0", "0", "'staff-demo'", "NULL", "0"],
    ["reason mismatch", "0", "0", "NULL", "'STAFF_REJECTED'", "0"],
  ])("rejects direct SQL invalid EVIDENCE_REQUIRED: %s", (_name, attempts, eligible, reviewer, reason, unlock) => {
    testDatabase = createTestDatabase();
    const instance = testDatabase.repository.createDemoInstance();
    const item = testDatabase.repository.listServerInternalFoundItems(instance.demoInstanceId)[0]!;
    testDatabase.database.exec("PRAGMA ignore_check_constraints = OFF");
    expect(() => testDatabase!.database.prepare(`
      INSERT INTO lost_reports (
        demo_instance_id, id, owner_actor_id, category, time_from, time_to,
        area, color, public_tags_json, public_description, status, version
      ) VALUES (?, 'report-direct', 'claimant-demo', 'earbuds', 'a', 'b',
        'library', 'black', '[]', 'direct fixture', 'PUBLISHED', 1)
    `).run(instance.demoInstanceId)).not.toThrow();
    expectConstraintViolation(() => testDatabase!.database.prepare(`
      INSERT INTO claims (
        demo_instance_id, id, report_id, found_item_id, claimant_actor_id,
        status, attempts, evidence_eligible, reviewer_actor_id, rejection_reason,
        unlock_count, pass_generation, version
      ) VALUES (?, 'claim-direct', 'report-direct', ?, 'claimant-demo',
        'EVIDENCE_REQUIRED', ${attempts}, ${eligible}, ${reviewer}, ${reason},
        ${unlock}, 0, 1)
    `).run(instance.demoInstanceId, item.inventoryItemId));
  });

  it("enforces status-specific reviewer/reason rules and the one-unlock transition", () => {
    testDatabase = createTestDatabase();
    const instance = testDatabase.repository.createDemoInstance();
    const item = testDatabase.repository.listServerInternalFoundItems(instance.demoInstanceId)[0]!;
    const report = testDatabase.repository.createLostReport({
      demoInstanceId: instance.demoInstanceId,
      ownerActorId: "claimant-demo",
      category: "earbuds",
      timeWindow: { from: "a", to: "b" },
      area: "library",
      color: "black",
      publicTags: [],
      publicDescription: "review fixture",
    });
    testDatabase.repository.publishLostReport({
      demoInstanceId: instance.demoInstanceId,
      reportId: report.reportId,
      expectedVersion: report.version,
      actorId: "claimant-demo",
    });
    const claim = testDatabase.repository.createClaim({
      demoInstanceId: instance.demoInstanceId,
      reportId: report.reportId,
      inventoryItemId: item.inventoryItemId,
      claimantActorId: "claimant-demo",
    });
    expectConstraintViolation(() => testDatabase!.database.prepare(`
      UPDATE claims SET status = 'REJECTED', rejection_reason = NULL
      WHERE demo_instance_id = ? AND id = ?
    `).run(instance.demoInstanceId, claim.claimId));
    testDatabase.database.prepare(`
      UPDATE claims SET status = 'LOCKED', attempts = 3
      WHERE demo_instance_id = ? AND id = ?
    `).run(instance.demoInstanceId, claim.claimId);
    testDatabase.database.prepare(`
      UPDATE claims SET status = 'EVIDENCE_REQUIRED', attempts = 0, unlock_count = 1
      WHERE demo_instance_id = ? AND id = ?
    `).run(instance.demoInstanceId, claim.claimId);
    expectConstraintViolation(() => testDatabase!.database.prepare(`
      UPDATE claims SET status = 'LOCKED', attempts = 3, unlock_count = 0
      WHERE demo_instance_id = ? AND id = ?
    `).run(instance.demoInstanceId, claim.claimId));
  });
});

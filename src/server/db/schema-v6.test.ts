import { afterEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./test-harness";

let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

function seedApprovedClaim() {
  testDatabase = createTestDatabase();
  const instance = testDatabase.repository.createDemoInstance();
  const item = testDatabase.repository.listServerInternalFoundItems(instance.demoInstanceId)[0]!;
  testDatabase.database.prepare(`
    INSERT INTO lost_reports (
      demo_instance_id, id, owner_actor_id, category, time_from, time_to,
      area, color, public_tags_json, public_description, status, version
    ) VALUES (?, 'report-v6', 'claimant-demo', 'earbuds', 'a', 'b',
      'library', 'black', '[]', 'v6 fixture', 'PUBLISHED', 3)
  `).run(instance.demoInstanceId);
  testDatabase.database.prepare(`
    UPDATE found_items SET status = 'HELD', version = 4
    WHERE demo_instance_id = ? AND id = ?
  `).run(instance.demoInstanceId, item.inventoryItemId);
  testDatabase.database.prepare(`
    INSERT INTO claims (
      demo_instance_id, id, report_id, found_item_id, claimant_actor_id,
      status, attempts, evidence_eligible, reviewer_actor_id, rejection_reason,
      unlock_count, pass_generation, version
    ) VALUES (?, 'claim-v6', 'report-v6', ?, 'claimant-demo',
      'APPROVED', 1, 1, 'staff-demo', NULL, 0, 0, 5)
  `).run(instance.demoInstanceId, item.inventoryItemId);
  return { instance, item };
}

function expectConstraint(operation: () => unknown): void {
  let caught: unknown;
  try { operation(); } catch (error) { caught = error; }
  expect(caught).toBeDefined();
  expect(String((caught as Error).message)).not.toMatch(/no such column|has no column/i);
}

describe("schema v6 pickup pass invariants", () => {
  it("creates schema v6 with the consumed barrier and extended closed contracts", () => {
    seedApprovedClaim();
    expect(testDatabase!.database.prepare(
      "SELECT schema_version AS version FROM database_metadata WHERE singleton_id = 1",
    ).get()).toEqual({ version: 6 });
    const columns = testDatabase!.database.pragma("table_info(claims)") as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).toContain("pickup_pass_consumed_at_ms");
    const idempotencySql = (testDatabase!.database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'idempotency_records'
    `).get() as { sql: string }).sql;
    expect(idempotencySql).toContain("'pickup_issue'");
    expect(idempotencySql).toContain("'pickup_reissue'");
    expect(idempotencySql).toContain("'handoff'");
    const eventsSql = (testDatabase!.database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'claim_events'
    `).get() as { sql: string }).sql;
    expect(eventsSql).toContain("'PASS_ISSUED'");
    expect(eventsSql).toContain("'PASS_REISSUED'");
    expect(eventsSql).toContain("'HANDOFF_COMPLETED'");
  });

  it("couples issue, reissue and collection to exact pass-field transitions", () => {
    const { instance } = seedApprovedClaim();
    expectConstraint(() => testDatabase!.database.prepare(`
      UPDATE claims SET pickup_pass_salt = randomblob(32),
        pickup_pass_digest = randomblob(32), pickup_pass_expires_at_ms = 999999,
        pass_generation = 1, version = version + 1
      WHERE demo_instance_id = ? AND id = 'claim-v6'
    `).run(instance.demoInstanceId));

    testDatabase!.database.prepare(`
      UPDATE claims SET status = 'PICKUP_READY', pickup_pass_salt = zeroblob(32),
        pickup_pass_digest = randomblob(32), pickup_pass_expires_at_ms = 999999,
        pass_generation = 1, version = version + 1
      WHERE demo_instance_id = ? AND id = 'claim-v6'
    `).run(instance.demoInstanceId);
    expectConstraint(() => testDatabase!.database.prepare(`
      UPDATE claims SET pickup_pass_salt = randomblob(32),
        pickup_pass_digest = randomblob(32), pickup_pass_expires_at_ms = 1000000,
        version = version + 1 WHERE demo_instance_id = ? AND id = 'claim-v6'
    `).run(instance.demoInstanceId));

    testDatabase!.database.prepare(`
      UPDATE claims SET pickup_pass_salt = randomblob(32),
        pickup_pass_digest = randomblob(32), pickup_pass_expires_at_ms = 1000000,
        pass_generation = 2, version = version + 1
      WHERE demo_instance_id = ? AND id = 'claim-v6'
    `).run(instance.demoInstanceId);
    expectConstraint(() => testDatabase!.database.prepare(`
      UPDATE claims SET status = 'COLLECTED', version = version + 1
      WHERE demo_instance_id = ? AND id = 'claim-v6'
    `).run(instance.demoInstanceId));

    testDatabase!.database.prepare(`
      UPDATE claims SET status = 'COLLECTED', pickup_pass_consumed_at_ms = 900000,
        version = version + 1 WHERE demo_instance_id = ? AND id = 'claim-v6'
    `).run(instance.demoInstanceId);
    expectConstraint(() => testDatabase!.database.prepare(`
      UPDATE claims SET pickup_pass_digest = randomblob(32), version = version + 1
      WHERE demo_instance_id = ? AND id = 'claim-v6'
    `).run(instance.demoInstanceId));
  });
});
